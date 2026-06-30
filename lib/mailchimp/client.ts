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
  // ── Details ─────────────────────────────────────────────────────────────
  errors: { email: string; error: string }[]  // hard errors from either step
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

// Normalize a phone number to E.164 for Mailchimp's SMS phone (SMSPHONE) field.
// Mailchimp requires SMS numbers in E.164 — e.g. +17605551234, not
// (760) 555-1234. Returns '' when the input can't be confidently normalized
// (wrong digit count) so we omit the field rather than send a value Mailchimp
// would reject. Assumes US (+1) when no country code is present.
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
    const members = batch.map(c => {
      const merge_fields: Record<string, string> = {
        FNAME: c.first_name ?? '',
        LNAME: c.last_name ?? '',
        PHONE: c.phone ?? '',
        CITY: c.city ?? '',
        ZIP: c.postal_code ?? '',
        LEADSRC: c.lead_source ?? '',
        LASTSERV: formatLongDate(c.last_serviced_date),
        BALANCE: c.account_balance != null ? String(c.account_balance) : '',
      }
      // Mailchimp's SMS phone field (SMSPHONE) is separate from the regular
      // PHONE field and requires E.164. Only send it when we can produce a
      // valid E.164 number; an empty/invalid value would error the member. The
      // field only exists when SMS marketing is enabled on the audience —
      // otherwise Mailchimp silently drops it (it's not in REQUIRED_MERGE_FIELDS
      // because it's Mailchimp-managed and can't be created via merge-fields).
      const smsPhone = toE164(c.phone)
      if (smsPhone) merge_fields.SMSPHONE = smsPhone
      return {
        email_address: c.email,
        status_if_new: 'subscribed',
        // Apply the campaign tag (and "sms only" where relevant) atomically with
        // the add/update. The batch endpoint supports per-member tags and
        // auto-creates them — far more reliable than the separate segment-add
        // step, which fails for members that aren't queryable yet.
        tags: c.sms_only ? [tag, 'sms only'] : [tag],
        merge_fields,
      }
    })

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

  return result
}
