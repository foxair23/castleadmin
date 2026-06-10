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
  total: number     // total contacts sent to Mailchimp
  added: number
  updated: number
  unchanged: number // already in Mailchimp with identical data (tagged but not counted as added/updated)
  skipped: number   // already unsubscribed in Mailchimp
  errored: number
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

/** Bulk-add emails to a static segment (tag). Processes in chunks of 500. */
async function addEmailsToSegment(segmentId: string, emails: string[]): Promise<void> {
  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    const chunk = emails.slice(i, i + BATCH_SIZE)
    await mcFetch(`/lists/${AUDIENCE_ID}/segments/${segmentId}`, {
      method: 'POST',
      body: JSON.stringify({ members_to_add: chunk }),
    })
  }
}

export async function pushContacts(contacts: MailchimpContact[], tag: string): Promise<PushResult> {
  const result: PushResult = { total: contacts.length, added: 0, updated: 0, unchanged: 0, skipped: 0, errored: 0, errors: [] }

  if (!API_KEY || !SERVER_PREFIX || !AUDIENCE_ID) {
    return { ...result, errored: contacts.length, errors: contacts.map(c => ({ email: c.email, error: 'Mailchimp not configured' })) }
  }

  // Process in batches of 500
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

    const batchAdded = data.new_members?.length ?? 0
    const batchUpdated = data.updated_members?.length ?? 0
    result.added += batchAdded
    result.updated += batchUpdated

    // Count errors
    const batchErrors: { email: string; error: string }[] = []
    let batchSkipped = 0
    let batchErrored = 0
    for (const err of (data.errors ?? [])) {
      const email = err.email_address ?? ''
      const msg: string = err.error ?? 'Unknown error'
      // Unsubscribe-related errors count as skipped
      if (
        msg.includes('Member Exists') ||
        msg.toLowerCase().includes('unsubscrib') ||
        msg.toLowerCase().includes('resubscrib')
      ) {
        batchSkipped++
      } else {
        batchErrored++
        batchErrors.push({ email, error: msg })
      }
    }
    result.skipped += batchSkipped
    result.errored += batchErrored
    result.errors.push(...batchErrors)

    // Contacts Mailchimp accepted but didn't count (already existed with identical data)
    result.unchanged += batch.length - batchAdded - batchUpdated - batchSkipped - batchErrored
  }

  // Apply the tag to ALL contacts via Mailchimp's static segment (tag) API.
  // This is the only reliable method for existing members whose data didn't
  // change — the batch import payload's `tags` field is only applied when
  // Mailchimp actually processes a member (new or updated), not for unchanged ones.
  const allEmails = contacts.map(c => c.email)
  const smsEmails = contacts.filter(c => c.sms_only).map(c => c.email)
  const segmentId = await getOrCreateSegment(tag)
  if (segmentId) await addEmailsToSegment(segmentId, allEmails)
  if (smsEmails.length > 0) {
    const smsSegmentId = await getOrCreateSegment('sms only')
    if (smsSegmentId) await addEmailsToSegment(smsSegmentId, smsEmails)
  }

  return result
}
