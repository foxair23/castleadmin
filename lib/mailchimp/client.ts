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

/** Get an existing static segment by name, or create it if it doesn't exist. Returns the segment ID. */
async function getOrCreateSegment(tagName: string): Promise<string | null> {
  try {
    // Fetch up to 1000 existing static segments (tags)
    const listRes = await mcFetch(`/lists/${AUDIENCE_ID}/segments?type=static&count=1000&fields=segments.id,segments.name`)
    if (!listRes.ok) return null
    const listData = await listRes.json()
    const existing = (listData.segments ?? []).find((s: { id: number; name: string }) => s.name === tagName)
    if (existing) return String(existing.id)

    // Create it
    const createRes = await mcFetch(`/lists/${AUDIENCE_ID}/segments`, {
      method: 'POST',
      body: JSON.stringify({ name: tagName, type: 'static', static_segment: [] }),
    })
    if (!createRes.ok) return null
    const created = await createRes.json()
    return created.id ? String(created.id) : null
  } catch {
    return null
  }
}

/** Bulk-add emails to a static segment (tag).
 *  Returns { tagged, failed } where tagged = emails successfully in the segment,
 *  failed = emails Mailchimp explicitly rejected (unsubscribed, invalid, etc.).
 *  Members already in the segment are silently accepted and counted as tagged.
 */
async function addEmailsToSegment(segmentId: string, emails: string[]): Promise<{ tagged: number; failed: number }> {
  let failed = 0
  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    const chunk = emails.slice(i, i + BATCH_SIZE)
    const res = await mcFetch(`/lists/${AUDIENCE_ID}/segments/${segmentId}`, {
      method: 'POST',
      body: JSON.stringify({ members_to_add: chunk }),
    })
    if (res.ok) {
      const data = await res.json()
      // Each error entry covers one or more email addresses
      for (const err of (data.errors ?? [])) {
        failed += err.email_addresses?.length ?? 1
      }
    } else {
      // Whole chunk failed — count all as failed
      failed += chunk.length
    }
  }
  return { tagged: emails.length - failed, failed }
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

  // ── Step 1: Upsert contacts into the Mailchimp audience ─────────────────
  // Adds new contacts, updates existing profile data. Unsubscribed / cleaned
  // contacts cannot be re-subscribed via API and will appear in errors.
  for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
    const batch = contacts.slice(i, i + BATCH_SIZE)
    const members = batch.map(c => ({
      email_address: c.email,
      status_if_new: 'subscribed',
      merge_fields: {
        FNAME: c.first_name ?? '',
        LNAME: c.last_name ?? '',
        PHONE: c.phone ?? '',
        CITY: c.city ?? '',
        ZIP: c.postal_code ?? '',
        LEADSRC: c.lead_source ?? '',
        LASTSERV: c.last_serviced_date ?? '',
        BALANCE: c.account_balance != null ? String(c.account_balance) : '',
      },
    }))

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
