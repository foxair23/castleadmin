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
  total: number      // all contacts selected
  no_email: number   // no real email — skipped entirely
  tagged: number     // confirmed in the segment (newly added + already there)
  not_taggable: number // rejected by segment API (true unsubscribes, hard bounces, etc.)
  errored: number    // batch import errors (invalid email format, etc.)
  errors: { email: string; error: string }[]
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
  const smsOnly = contacts.filter(c => c.sms_only)
  const realEmailContacts = contacts.filter(c => !c.sms_only)
  const result: PushResult = {
    total: contacts.length,
    no_email: smsOnly.length,
    tagged: 0,
    not_taggable: 0,
    errored: 0,
    errors: [],
  }

  if (!API_KEY || !SERVER_PREFIX || !AUDIENCE_ID) {
    return { ...result, errored: contacts.length, errors: contacts.map(c => ({ email: c.email, error: 'Mailchimp not configured' })) }
  }

  // Step 1: Upsert all contacts into the Mailchimp audience (adds new, updates existing profile data).
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
    const data = await res.json()
    for (const err of (data.errors ?? [])) {
      const email = err.email_address ?? ''
      const msg: string = err.error ?? 'Unknown error'
      if (!msg.toLowerCase().includes('unsubscrib') && !msg.toLowerCase().includes('resubscrib')) {
        result.errored++
        result.errors.push({ email, error: msg })
      }
    }
  }

  // Step 2: Apply the tag via the static segment API.
  // Only real-email contacts — SMS-only placeholder addresses are not valid audience members.
  // Members already in the segment are silently accepted (not double-counted as new).
  if (realEmailContacts.length > 0) {
    const segmentId = await getOrCreateSegment(tag)
    if (segmentId) {
      const { tagged, failed } = await addEmailsToSegment(segmentId, realEmailContacts.map(c => c.email))
      result.tagged = tagged
      result.not_taggable = failed
    }
  }

  return result
}
