import { NextRequest, NextResponse } from 'next/server'
import { parseLead, type RawInboundEmail } from '@/lib/leadgen/parse'
import { ingestLead } from '@/lib/leadgen/engine'

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

// Pull the full received email (with body) from Resend by id.
async function fetchReceivedEmail(id: string): Promise<RawInboundEmail | null> {
  const key = process.env.RESEND_API_KEY
  if (!key) return null
  try {
    const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${key}` },
    })
    if (!res.ok) return null
    const d = (await res.json()) as Record<string, unknown>
    return extractEmail(d)
  } catch {
    return null
  }
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

  // Prefer an inline body; otherwise fetch the full email by id.
  let email: RawInboundEmail
  if (data.text || data.html) {
    email = extractEmail(data)
  } else {
    const id = (data.email_id as string) ?? (data.id as string) ?? null
    if (!id) return NextResponse.json({ ok: true, ignored: 'no body and no email id' })
    const full = await fetchReceivedEmail(id)
    if (!full) return NextResponse.json({ ok: true, ignored: 'could not fetch email body' })
    email = full
  }

  const parsed = parseLead(email)
  if (!parsed) return NextResponse.json({ ok: true, ignored: 'not a recognized lead' })

  try {
    const result = await ingestLead(parsed.parsed, parsed.text)
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    return NextResponse.json({ ok: true, error: e instanceof Error ? e.message : String(e) })
  }
}
