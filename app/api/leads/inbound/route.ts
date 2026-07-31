import { NextRequest, NextResponse } from 'next/server'
import { parseLead, type RawInboundEmail } from '@/lib/leadgen/parse'
import { ingestLead, logInboundEvent } from '@/lib/leadgen/engine'

export const maxDuration = 60

// Inbound provider-lead email (via Resend Inbound). Forwarded HD "new lead"
// emails land here; we parse and ingest them. Guarded by a shared secret passed
// as ?token= (or x-leadgen-secret header) so only our Resend webhook can post.
//
// IMPORTANT: Resend's `email.received` webhook is METADATA ONLY (from/to/subject
// + attachment names) — the body is not in the payload. We take the received
// email's id and fetch the full message (text/html) from the Received Emails API
// before parsing. If a payload already carries the body (other providers / tests)
// we use it directly.
//
// Always returns 200 on parse/ingest issues so the sender doesn't retry-storm;
// a bad/missing token is the one hard failure.

function fromToString(fromField: unknown): string | null {
  if (typeof fromField === 'string') return fromField || null
  if (fromField && typeof fromField === 'object') {
    const o = fromField as Record<string, unknown>
    return String(o.address ?? o.email ?? o.from ?? '') || null
  }
  return null
}

function extractEmail(d: Record<string, unknown>): RawInboundEmail {
  return {
    from: fromToString(d.from),
    subject: (d.subject as string) ?? null,
    text: (d.text as string) ?? (d.plain as string) ?? null,
    html: (d.html as string) ?? null,
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Pull the full received email (with body) from Resend by id. Returns the email
// or a human-readable error for the inbound log. The body can lag the webhook by
// a moment, so retry a few times on 404/not-ready and transient 5xx.
async function fetchReceivedEmail(id: string): Promise<{ email?: RawInboundEmail; error?: string }> {
  const key = process.env.RESEND_API_KEY
  if (!key) return { error: 'RESEND_API_KEY not set' }
  const url = `https://api.resend.com/emails/receiving/${encodeURIComponent(id)}`
  let lastError = 'unknown'
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(1000)
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } })
      if (res.ok) {
        const d = (await res.json()) as Record<string, unknown>
        return { email: extractEmail((d.data && typeof d.data === 'object' ? d.data : d) as Record<string, unknown>) }
      }
      const body = await res.text().catch(() => '')
      lastError = `HTTP ${res.status}: ${body.slice(0, 300)}`
      // Auth/permission errors won't fix themselves — stop retrying.
      if (res.status === 401 || res.status === 403) break
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
  }
  return { error: lastError }
}

export async function POST(req: NextRequest) {
  const secret = process.env.LEADGEN_INBOUND_SECRET
  if (secret) {
    const token = req.nextUrl.searchParams.get('token') ?? req.headers.get('x-leadgen-secret')
    if (token !== secret) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ ok: true, ignored: 'unparseable body' }) }

  // Ignore non-inbound webhook events (email.sent/bounced/etc.) if this endpoint
  // ever receives them.
  const type = body.type as string | undefined
  if (type && type !== 'email.received' && type !== 'inbound.email') {
    return NextResponse.json({ ok: true, ignored: `event ${type}` })
  }

  const data = (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, unknown>
  const emailId = (data.email_id as string) ?? (data.id as string) ?? null
  const metaFrom = fromToString(data.from)
  const metaSubject = (data.subject as string) ?? null

  // Prefer an inline body; otherwise fetch the full email by id.
  let email: RawInboundEmail
  if (data.text || data.html) {
    email = extractEmail(data)
  } else {
    if (!emailId) {
      await logInboundEvent({ from_addr: metaFrom, subject: metaSubject, resend_email_id: null, outcome: 'error', detail: 'no body and no email id' })
      return NextResponse.json({ ok: true, ignored: 'no body and no email id' })
    }
    const { email: full, error } = await fetchReceivedEmail(emailId)
    if (!full) {
      await logInboundEvent({ from_addr: metaFrom, subject: metaSubject, resend_email_id: emailId, outcome: 'fetch_failed', detail: `fetch body: ${error ?? 'unknown'}` })
      return NextResponse.json({ ok: true, ignored: 'could not fetch email body', detail: error })
    }
    email = full
  }

  const parsed = parseLead(email)
  if (!parsed) {
    await logInboundEvent({ from_addr: email.from ?? metaFrom, subject: email.subject ?? metaSubject, resend_email_id: emailId, outcome: 'not_lead', detail: 'no recognized provider / no contact info' })
    return NextResponse.json({ ok: true, ignored: 'not a recognized lead' })
  }

  try {
    const result = await ingestLead(parsed.parsed, parsed.text)
    await logInboundEvent({
      from_addr: email.from ?? metaFrom, subject: email.subject ?? metaSubject, resend_email_id: emailId,
      outcome: result.status, lead_id: result.leadId,
      detail: result.sent.length ? `sent: ${result.sent.join(', ')}` : null,
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    await logInboundEvent({ from_addr: email.from ?? metaFrom, subject: email.subject ?? metaSubject, resend_email_id: emailId, outcome: 'error', detail })
    return NextResponse.json({ ok: true, error: detail })
  }
}
