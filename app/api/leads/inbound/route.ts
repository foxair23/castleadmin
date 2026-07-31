import { NextRequest, NextResponse } from 'next/server'
import { parseLead, type RawInboundEmail } from '@/lib/leadgen/parse'
import { ingestLead } from '@/lib/leadgen/engine'

export const maxDuration = 60

// Inbound provider-lead email (via Resend Inbound). Forwarded HD "new lead"
// emails land here; we parse and ingest them. Guarded by a shared secret passed
// as ?token= (or x-leadgen-secret header) so only our Resend webhook can post.
//
// Always returns 200 on parse/ingest issues so the sender doesn't retry-storm;
// a bad/missing token is the one hard failure.

function extractEmail(body: Record<string, unknown>): RawInboundEmail {
  // Resend wraps the message under `data`; accept top-level too.
  const d = (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, unknown>
  const fromField = d.from
  const from = typeof fromField === 'string'
    ? fromField
    : (fromField && typeof fromField === 'object' ? String((fromField as Record<string, unknown>).address ?? '') : null)
  return {
    from: from || null,
    subject: (d.subject as string) ?? null,
    text: (d.text as string) ?? (d.plain as string) ?? null,
    html: (d.html as string) ?? null,
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

  const email = extractEmail(body)
  const parsed = parseLead(email)
  if (!parsed) return NextResponse.json({ ok: true, ignored: 'not a recognized lead' })

  try {
    const result = await ingestLead(parsed.parsed, parsed.text)
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    return NextResponse.json({ ok: true, error: e instanceof Error ? e.message : String(e) })
  }
}
