// Server-side only — never import this in client components

const API_KEY = process.env.MAILCHIMP_API_KEY ?? ''
const AUDIENCE_ID = process.env.MAILCHIMP_AUDIENCE_ID ?? ''
const SERVER_PREFIX = process.env.MAILCHIMP_SERVER_PREFIX ?? ''

function baseUrl() {
  return `https://${SERVER_PREFIX}.api.mailchimp.com/3.0`
}

function authHeader() {
  const encoded = Buffer.from(`anystring:${API_KEY}`).toString('base64')
  return `Basic ${encoded}`
}

async function mcFetch(path: string, options?: RequestInit) {
  const url = `${baseUrl()}${path}`
  return fetch(url, {
    ...options,
    headers: {
      'Authorization': authHeader(),
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
  })
}

export async function pingMailchimp(): Promise<{ ok: boolean; error?: string }> {
  if (!API_KEY || !SERVER_PREFIX) {
    return { ok: false, error: 'Mailchimp environment variables not configured' }
  }
  try {
    const res = await mcFetch('/ping')
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      return { ok: false, error: body.detail ?? `HTTP ${res.status}` }
    }
    return { ok: true }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' }
  }
}

export async function getAudienceInfo(): Promise<{ id: string; name: string; member_count: number } | null> {
  if (!API_KEY || !SERVER_PREFIX || !AUDIENCE_ID) return null
  try {
    const res = await mcFetch(`/lists/${AUDIENCE_ID}?fields=id,name,stats`)
    if (!res.ok) return null
    const data = await res.json()
    return {
      id: data.id,
      name: data.name,
      member_count: data.stats?.member_count ?? 0,
    }
  } catch {
    return null
  }
}

export interface MailchimpContact {
  email: string
  first_name: string | null
  last_name: string | null
  phone: string | null
  city: string | null
  postal_code: string | null
  lead_source: string | null
  last_serviced_date: string | null  // YYYY-MM-DD
  account_balance: number | null
  sms_only?: boolean
}

export interface PushResult {
  total: number          // contacts passed to this function
  // ── Mailchimp audience upsert (Step 1) ──────────────────────────────────
  audience_added: number    // newly added to the Mailchimp audience this push
  audience_updated: number  // already existed, profile data updated
  audience_unchanged: number // already existed, no data change (silently accepted)
  audience_skipped: number  // compliance state: unsubscribed / cleaned / bounced
  audience_errored: number  // other hard errors (invalid email format, etc.)
  // ── Segment / tag (Step 2) ───────────────────────────────────────────────
  tagged: number         // confirmed in segment after this push
  not_taggable: number   // segment API rejected (unsubscribed, cleaned, etc.)
  // ── SMS phone number (Step 4) ────────────────────────────────────────────
  sms_set: number        // contacts whose SMS phone number was set (E.164)
  sms_skipped: number    // no phone / couldn't normalize to E.164
  sms_failed: number     // Mailchimp rejected the SMS update
  // ── Details ─────────────────────────────────────────────────────────────
  errors: { email: string; error: string }[]  // hard errors from any step
}

const BATCH_SIZE = 500

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

// Format a 'YYYY-MM-DD' date as e.g. "January 31, 2025" for the LASTSERV merge
// field. Parsed from parts (not new Date) to avoid timezone shifts. Returns ''
// for empty/invalid input.
function formatLongDate(s: string | null | undefined): string {
  if (!s) return ''
  const [y, m, d] = s.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d || m < 1 || m > 12) return ''
  return `${MONTH_NAMES[m - 1]} ${d}, ${y}`
}

// Normalize a phone number to E.164 for Mailchimp's SMS phone number field.
// Mailchimp requires SMS numbers in E.164 — e.g. +17605551234, not
// (760) 555-1234. Returns '' when the input can't be confidently normalized
// (wrong digit count) so we skip the SMS update rather than send a value
// Mailchimp would reject. Assumes US (+1) when no country code is present.
function toE164(raw: string | null | undefined): string {
  if (!raw) return ''
  const trimmed = raw.trim()
  // Already E.164-style: keep the leading + and strip any other punctuation.
  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1).replace(/\D/g, '')
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : ''
  }
  const digits = trimmed.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`                          // US 10-digit
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}` // US with country code
  return '' // can't confidently normalize — omit rather than send an invalid number
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function findSegmentByName(tagName: string): Promise<string | null> {
  const listRes = await mcFetch(`/lists/${AUDIENCE_ID}/segments?type=static&count=1000&fields=segments.id,segments.name`)
  if (!listRes.ok) return null
  const listData = await listRes.json()
  const existing = (listData.segments ?? []).find((s: { id: number; name: string }) => s.name === tagName)
  return existing ? String(existing.id) : null
}

/** Get an existing static segment by name, or create it if it doesn't exist. Returns the segment ID. */
async function getOrCreateSegment(tagName: string): Promise<string | null> {
  try {
    const found = await findSegmentByName(tagName)
    if (found) return found

    const createRes = await mcFetch(`/lists/${AUDIENCE_ID}/segments`, {
      method: 'POST',
      body: JSON.stringify({ name: tagName, type: 'static', static_segment: [] }),
    })
    if (createRes.ok) {
      const created = await createRes.json()
      if (created.id) return String(created.id)
    }
    // Create failed (e.g. name already exists from a concurrent/earlier batch) —
    // re-fetch so a batch never silently skips tagging.
    return await findSegmentByName(tagName)
  } catch {
    return null
  }
}

// Custom merge fields we populate on every push. Mailchimp silently drops
// merge values whose field doesn't exist on the audience, so we create any
// missing ones first. FNAME/LNAME/PHONE are Mailchimp defaults. All are 'text'
// so values (incl. the YYYY-MM-DD last service date) render as-is in emails via
// e.g. *|LASTSERV|*.
const REQUIRED_MERGE_FIELDS: { tag: string; name: string }[] = [
  { tag: 'CITY', name: 'City' },
  { tag: 'ZIP', name: 'Zip' },
  { tag: 'LEADSRC', name: 'Lead Source' },
  { tag: 'LASTSERV', name: 'Last Serviced' },
  { tag: 'BALANCE', name: 'Balance' },
]

/** Ensure the custom merge fields exist on the audience; create any missing. */
async function ensureMergeFields(): Promise<void> {
  try {
    const res = await mcFetch(`/lists/${AUDIENCE_ID}/merge-fields?count=200&fields=merge_fields.tag`)
    if (!res.ok) return
    const data = await res.json()
    const existing = new Set<string>((data.merge_fields ?? []).map((m: { tag: string }) => m.tag))
    for (const f of REQUIRED_MERGE_FIELDS) {
      if (existing.has(f.tag)) continue
      const createRes = await mcFetch(`/lists/${AUDIENCE_ID}/merge-fields`, {
        method: 'POST',
        body: JSON.stringify({ tag: f.tag, name: f.name, type: 'text', required: false, public: false }),
      })
      if (!createRes.ok) {
        const body = await createRes.json().catch(() => ({}))
        console.error('[mailchimp] merge-field create failed:', f.tag, body?.detail ?? createRes.status)
      }
    }
  } catch (e) {
    console.error('[mailchimp] ensureMergeFields error:', e)
  }
}

/** Bulk-add emails to a static segment (tag).
 *  Returns { tagged, failed } where tagged = emails successfully in the segment,
 *  failed = emails Mailchimp explicitly rejected (unsubscribed, invalid, etc.).
 *  Members already in the segment are silently accepted and counted as tagged.
 */
async function addEmailsToSegment(segmentId: string, emails: string[]): Promise<{ tagged: number; failed: number }> {
  // One pass over a list; returns the emails Mailchimp rejected (e.g. not yet in
  // the audience, unsubscribed, invalid).
  async function addPass(list: string[]): Promise<string[]> {
    const rejected: string[] = []
    for (let i = 0; i < list.length; i += BATCH_SIZE) {
      const chunk = list.slice(i, i + BATCH_SIZE)
      const res = await mcFetch(`/lists/${AUDIENCE_ID}/segments/${segmentId}`, {
        method: 'POST',
        body: JSON.stringify({ members_to_add: chunk }),
      })
      if (res.ok) {
        const data = await res.json()
        for (const err of (data.errors ?? [])) {
          for (const e of (err.email_addresses ?? [])) rejected.push(e)
        }
      } else {
        rejected.push(...chunk)
      }
    }
    return rejected
  }

  let rejected = await addPass(emails)
  // Members just upserted in this batch may not be queryable instantly, so the
  // segment add rejects them. Wait briefly and retry the rejects — this is the
  // common reason contacts ended up in the audience but untagged.
  for (let attempt = 0; attempt < 2 && rejected.length > 0; attempt++) {
    await sleep(2500)
    rejected = await addPass(rejected)
  }
  return { tagged: emails.length - rejected.length, failed: rejected.length }
}

// The SMS phone number and its marketing consent can ONLY be written through
// the omni-channel Audiences API (POST /audiences/{id}/contacts, sms_channel).
// The classic /lists/{id}/members endpoints expose SMS fields as read-only, so
// setting them there silently does nothing — which is why SMS never registered.
//
// The Audiences API uses its own audience id. In practice it equals the classic
// list id, but resolve it defensively: prefer the audience whose id matches our
// list id, then any SMS-enabled audience, then fall back to the list id.
let cachedSmsAudienceId: string | null = null
async function resolveSmsAudienceId(): Promise<string> {
  if (cachedSmsAudienceId) return cachedSmsAudienceId
  try {
    const res = await mcFetch('/audiences?count=100&fields=audiences.id,audiences.enabled_channels')
    if (res.ok) {
      const data = await res.json()
      const auds: { id: string; enabled_channels?: string[] }[] = data.audiences ?? []
      const exact = auds.find(a => a.id === AUDIENCE_ID)
      const smsEnabled = auds.find(a => (a.enabled_channels ?? []).some(c => c.toLowerCase().includes('sms')))
      cachedSmsAudienceId = exact?.id ?? smsEnabled?.id ?? AUDIENCE_ID
      return cachedSmsAudienceId
    }
  } catch { /* fall through */ }
  cachedSmsAudienceId = AUDIENCE_ID
  return cachedSmsAudienceId
}

// marketing_consent status for the SMS/email channels. Verified empirically via
// the diagnostic consent-value sweep against the (single opt-in) "Castle Garage"
// audience: 'consented' → 400 (rejected for single opt-in); 'unknown' → 200 but
// effective status stays 'nonsubscribed'; 'confirmed' → 200 AND effective status
// 'subscribed'. 'confirmed' is also the documented value for double opt-in
// audiences, so it's correct in both cases. (The OpenAPI spec's claim that
// single opt-in should use 'consented' is wrong — the live API rejects it.)
const CONSENT_STATUS = 'confirmed'

// POST a contact with an SMS channel + marketing consent to the Audiences API.
// Returns the parsed response so callers can inspect effective_subscription_status.
async function postAudienceContact(
  audienceId: string, email: string, e164: string, consentStatus: string, sourceName: string, capturedAt: string,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const consent = { status: consentStatus, source: { name: sourceName }, captured_at: capturedAt }
  const res = await mcFetch(`/audiences/${audienceId}/contacts`, {
    method: 'POST',
    body: JSON.stringify({
      email_channel: { email, marketing_consent: consent },
      sms_channel: { sms_phone: e164, marketing_consent: consent },
      update_existing: true,
    }),
  })
  const body = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, body }
}

// Add/refresh the SMS channel (E.164 number + marketing consent) for contacts
// with a valid number, via the Audiences API. update_existing merges onto the
// contact the classic upsert already created (matched by email), or creates it.
// The consent status is chosen to match the audience's opt-in config (see
// resolveConsentStatus). Runs with limited concurrency to respect Mailchimp's
// ~10 simultaneous-connection cap; hard rejections are surfaced in `errors`.
async function setSmsPhones(
  contacts: MailchimpContact[],
): Promise<{ set: number; skipped: number; failed: number; errors: { email: string; error: string }[] }> {
  const out = { set: 0, skipped: 0, failed: 0, errors: [] as { email: string; error: string }[] }

  // Only contacts with a number we can normalize to E.164 are eligible.
  const eligible = contacts
    .map(c => ({ email: c.email, e164: toE164(c.phone) }))
    .filter(c => c.e164)
  out.skipped = contacts.length - eligible.length
  if (eligible.length === 0) return out

  const audienceId = await resolveSmsAudienceId()
  const consentStatus = CONSENT_STATUS
  const capturedAt = new Date().toISOString()

  // Tally the effective SMS subscription status Mailchimp reports back. A 2xx
  // only means the number was accepted — the contact may still land as
  // non-subscribed (e.g. audience needs opt-in confirmation, or SMS marketing
  // isn't fully enabled). We surface that so a "success" that doesn't actually
  // subscribe anyone is visible instead of silent.
  const effStatus: Record<string, number> = {}

  const CONCURRENCY = 8
  for (let i = 0; i < eligible.length; i += CONCURRENCY) {
    const slice = eligible.slice(i, i + CONCURRENCY)
    await Promise.all(slice.map(async ({ email, e164 }) => {
      try {
        const { ok, status, body } = await postAudienceContact(
          audienceId, email, e164, consentStatus, 'Castle Admin marketing push', capturedAt,
        )
        if (ok) {
          out.set++
          const eff = (body as { sms_channel?: { effective_subscription_status?: string } })?.sms_channel?.effective_subscription_status
          if (eff) effStatus[String(eff)] = (effStatus[String(eff)] ?? 0) + 1
        } else {
          out.failed++
          const msg = (body as { detail?: string; title?: string })?.detail ?? (body as { title?: string })?.title ?? `HTTP ${status}`
          console.error('[mailchimp] sms_channel set failed:', email, msg)
          out.errors.push({ email, error: `SMS phone: ${msg}` })
        }
      } catch (e) {
        out.failed++
        out.errors.push({ email, error: `SMS phone: ${e instanceof Error ? e.message : 'network error'}` })
      }
    }))
  }

  // If numbers were accepted but Mailchimp reports them as anything other than
  // subscribed, that's the real reason nothing "registers for SMS" — surface it.
  const notSubscribed = Object.entries(effStatus).filter(([s]) => s.toLowerCase() !== 'subscribed')
  if (notSubscribed.length > 0) {
    const summary = notSubscribed.map(([s, n]) => `${n} ${s}`).join(', ')
    console.error('[mailchimp] SMS numbers accepted but not subscribed:', summary)
    out.errors.push({
      email: '(sms)',
      error: `SMS number saved but not subscribed for: ${summary}. The audience likely requires SMS opt-in confirmation or SMS marketing isn't fully enabled in Mailchimp.`,
    })
  }
  return out
}

// Read-only-ish SMS diagnostic. Exercises the exact SMS write path for one
// contact and returns the RAW Mailchimp responses so we can see the ground
// truth (what /audiences returns, whether the POST succeeds, and the
// effective SMS subscription status the contact ends up with). Intended for a
// single manual test, not bulk use. Returns no secrets.
export async function debugSms(email: string | null, phone: string | null): Promise<Record<string, unknown>> {
  const e164 = toE164(phone)
  const config = {
    hasApiKey: !!API_KEY,
    hasServerPrefix: !!SERVER_PREFIX,
    serverPrefix: SERVER_PREFIX || null,
    audienceIdEnv: AUDIENCE_ID || null,
    baseUrl: baseUrl(),
  }
  const steps: Record<string, unknown>[] = []

  if (!API_KEY || !SERVER_PREFIX || !AUDIENCE_ID) {
    return { config, e164, steps, fatal: 'Mailchimp env vars not fully configured' }
  }

  // 1. What audiences does this account expose, and which channels are enabled?
  try {
    const r = await mcFetch('/audiences?count=100&fields=audiences.id,audiences.name,audiences.enabled_channels,total_items')
    const body = await r.json().catch(() => ({}))
    steps.push({ step: 'GET /audiences', status: r.status, ok: r.ok, body })
  } catch (e) {
    steps.push({ step: 'GET /audiences', error: String(e) })
  }

  // 2. Confirm the classic list exists / its name.
  try {
    const r = await mcFetch(`/lists/${AUDIENCE_ID}?fields=id,name,stats.member_count`)
    const body = await r.json().catch(() => ({}))
    steps.push({ step: `GET /lists/${AUDIENCE_ID}`, status: r.status, ok: r.ok, body })
  } catch (e) {
    steps.push({ step: 'GET /lists/{id}', error: String(e) })
  }

  const audienceId = await resolveSmsAudienceId()
  const consentStatus = CONSENT_STATUS
  steps.push({ step: 'resolved audience id', audienceId, equalsListId: audienceId === AUDIENCE_ID, consentStatusUsedByPush: consentStatus })

  // 3. The actual SMS write. Try each supported consent value and report the
  //    resulting effective_subscription_status so we can see which one actually
  //    subscribes the contact for THIS audience's opt-in config. Only runs when
  //    both email and a normalizable phone are supplied.
  if (!email || !phone) {
    steps.push({ step: 'POST contact', skipped: true, reason: 'pass ?email= and ?phone= to run the write test' })
  } else if (!e164) {
    steps.push({ step: 'toE164', input: phone, result: 'could not normalize to E.164 — would be skipped' })
  } else {
    const capturedAt = new Date().toISOString()
    const attempts: Record<string, unknown>[] = []
    for (const status of ['unknown', 'confirmed', 'consented'] as const) {
      try {
        const { ok, status: httpStatus, body } = await postAudienceContact(
          audienceId, email, e164, status, 'Castle Admin SMS debug', capturedAt,
        )
        const sms = (body as { sms_channel?: { effective_subscription_status?: string } })?.sms_channel
        attempts.push({
          consentStatusSent: status,
          httpStatus,
          ok,
          effective_subscription_status: sms?.effective_subscription_status ?? null,
          error: ok ? null : ((body as { detail?: string })?.detail ?? (body as { title?: string })?.title ?? null),
        })
      } catch (e) {
        attempts.push({ consentStatusSent: status, error: String(e) })
      }
    }
    steps.push({ step: `POST /audiences/${audienceId}/contacts (consent-value sweep)`, attempts })
  }

  return { config, e164, resolvedAudienceId: audienceId, consentStatusUsedByPush: consentStatus, steps }
}

export async function pushContacts(contacts: MailchimpContact[], tag: string): Promise<PushResult> {
  // Deduplicate by email — Mailchimp rejects batches containing duplicate addresses.
  // Keep the first occurrence (primary contact wins).
  const seen = new Set<string>()
  contacts = contacts.filter(c => {
    const key = c.email.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const smsOnly = contacts.filter(c => c.sms_only)
  const result: PushResult = {
    total: contacts.length,
    audience_added: 0,
    audience_updated: 0,
    audience_unchanged: 0,
    audience_skipped: 0,
    audience_errored: 0,
    tagged: 0,
    not_taggable: 0,
    sms_set: 0,
    sms_skipped: 0,
    sms_failed: 0,
    errors: [],
  }

  if (!API_KEY || !SERVER_PREFIX || !AUDIENCE_ID) {
    result.audience_errored = contacts.length
    result.errors = contacts.map(c => ({ email: c.email, error: 'Mailchimp not configured' }))
    return result
  }

  // Make sure the custom merge fields (incl. LASTSERV) exist before we send
  // values for them — otherwise Mailchimp drops them silently.
  await ensureMergeFields()

  // ── Step 1: Upsert contacts into the Mailchimp audience ─────────────────
  // Adds new contacts, updates existing profile data. Unsubscribed / cleaned
  // contacts cannot be re-subscribed via API and will appear in errors.
  for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
    const batch = contacts.slice(i, i + BATCH_SIZE)
    const members = batch.map(c => ({
      email_address: c.email,
      status_if_new: 'subscribed',
      // Apply the campaign tag (and "sms only" where relevant) atomically with
      // the add/update. The batch endpoint supports per-member tags and
      // auto-creates them — far more reliable than the separate segment-add
      // step, which fails for members that aren't queryable yet.
      tags: c.sms_only ? [tag, 'sms only'] : [tag],
      merge_fields: {
        FNAME: c.first_name ?? '',
        LNAME: c.last_name ?? '',
        PHONE: c.phone ?? '',
        CITY: c.city ?? '',
        ZIP: c.postal_code ?? '',
        LEADSRC: c.lead_source ?? '',
        LASTSERV: formatLongDate(c.last_serviced_date),
        BALANCE: c.account_balance != null ? String(c.account_balance) : '',
      },
    }))
    // NOTE: The SMS phone number is NOT a merge field and is NOT accepted by
    // this bulk endpoint — it must be set per-member via PUT (see Step 4).

    const res = await mcFetch(`/lists/${AUDIENCE_ID}`, {
      method: 'POST',
      body: JSON.stringify({ members, update_existing: true }),
    })

    if (!res.ok) {
      // Entire batch request failed (auth error, malformed request, etc.)
      const errBody = await res.json().catch(() => ({}))
      const msg = errBody?.detail ?? errBody?.title ?? `HTTP ${res.status}`
      console.error('[mailchimp] batch import failed:', msg, 'batch size:', batch.length)
      result.audience_errored += batch.length
      result.errors.push({ email: '(batch)', error: `Batch import failed: ${msg}` })
      continue
    }

    const data = await res.json()
    result.audience_added += data.new_members?.length ?? 0
    result.audience_updated += data.updated_members?.length ?? 0

    for (const err of (data.errors ?? [])) {
      const email: string = err.email_address ?? ''
      const msg: string = err.error ?? 'Unknown error'
      const msgLower = msg.toLowerCase()
      if (
        msgLower.includes('unsubscrib') ||
        msgLower.includes('resubscrib') ||
        msgLower.includes('compliance') ||
        msgLower.includes('cleaned') ||
        msgLower.includes('bounced') ||
        msgLower.includes('opted out')
      ) {
        // Compliance state — Mailchimp won't re-subscribe these via API
        result.audience_skipped++
      } else {
        result.audience_errored++
        result.errors.push({ email, error: msg })
      }
    }

    // Contacts not in any of the above buckets were already in Mailchimp
    // with identical data — silently accepted, no entry in any array
    const batchAccounted = (data.new_members?.length ?? 0)
      + (data.updated_members?.length ?? 0)
      + (data.errors?.length ?? 0)
    result.audience_unchanged += batch.length - batchAccounted
  }

  // ── Step 2: Apply the campaign tag via Mailchimp's static segment API ───
  // Works for all subscribed audience members regardless of data changes.
  // Unsubscribed / cleaned members will fail and be counted in not_taggable.
  const allEmails = contacts.map(c => c.email)
  if (allEmails.length > 0) {
    const segmentId = await getOrCreateSegment(tag)
    if (segmentId) {
      const { tagged, failed } = await addEmailsToSegment(segmentId, allEmails)
      result.tagged = tagged
      result.not_taggable = failed
    }
  }

  // ── Step 3: Tag SMS-only contacts with "sms only" ───────────────────────
  if (smsOnly.length > 0) {
    const smsSegmentId = await getOrCreateSegment('sms only')
    if (smsSegmentId) {
      await addEmailsToSegment(smsSegmentId, smsOnly.map(c => c.email))
    }
  }

  // ── Step 4: Set the SMS phone number (E.164) per member ─────────────────
  // Must be done after the audience upsert (Step 1) so the members exist, and
  // via the per-member endpoint since the bulk import doesn't accept SMS fields.
  const sms = await setSmsPhones(contacts)
  result.sms_set = sms.set
  result.sms_skipped = sms.skipped
  result.sms_failed = sms.failed
  result.errors.push(...sms.errors)

  return result
}
