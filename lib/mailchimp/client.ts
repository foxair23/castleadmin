import { createHash } from 'crypto'

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
  added: number
  updated: number
  skipped: number   // already unsubscribed in Mailchimp
  errored: number
  errors: { email: string; error: string }[]
}

function md5Email(email: string): string {
  return createHash('md5').update(email.toLowerCase()).digest('hex')
}

const BATCH_SIZE = 500

export async function pushContacts(contacts: MailchimpContact[], tag: string): Promise<PushResult> {
  const result: PushResult = { added: 0, updated: 0, skipped: 0, errored: 0, errors: [] }

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

    result.added += data.new_members?.length ?? 0
    result.updated += data.updated_members?.length ?? 0

    // Count errors
    const batchErrors: { email: string; error: string }[] = []
    for (const err of (data.errors ?? [])) {
      const email = err.email_address ?? ''
      const msg: string = err.error ?? 'Unknown error'
      // Unsubscribe-related errors count as skipped
      if (
        msg.includes('Member Exists') ||
        msg.toLowerCase().includes('unsubscrib') ||
        msg.toLowerCase().includes('resubscrib')
      ) {
        result.skipped++
      } else {
        result.errored++
        batchErrors.push({ email, error: msg })
      }
    }
    result.errors.push(...batchErrors)

    // Apply tag to every contact in the batch — not just new/updated ones.
    // Mailchimp's batch import silently skips unchanged existing members (they
    // don't appear in new_members or updated_members), so tagging only those
    // would miss anyone whose data hadn't changed since the last push.
    // SMS-only contacts (no real email) also get an "sms only" tag.
    await Promise.allSettled(
      batch.map((c: MailchimpContact) => {
        const tags: { name: string; status: string }[] = [{ name: tag, status: 'active' }]
        if (c.sms_only) tags.push({ name: 'sms only', status: 'active' })
        return mcFetch(`/lists/${AUDIENCE_ID}/members/${md5Email(c.email)}/tags`, {
          method: 'POST',
          body: JSON.stringify({ tags }),
        })
      })
    )
  }

  return result
}
