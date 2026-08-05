import { NextRequest, NextResponse } from 'next/server'
import { checkInboundSecret, extractEmail, fetchReceivedEmail } from '@/lib/inbound/resend'
import { ingestRemittance } from '@/lib/remittance/engine'

export const maxDuration = 60

// Inbound vendor payment-remittance email (via Resend Inbound). Vendors
// auto-forward to a dedicated Castle address pointed at this webhook. Guarded by
// a shared secret (?token= or x-remittance-secret). Always returns 200 so the
// sender doesn't retry-storm; a bad token is the one hard failure.
export async function POST(req: NextRequest) {
  if (!checkInboundSecret(req, 'REMITTANCE_INBOUND_SECRET', 'x-remittance-secret')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ ok: true, ignored: 'unparseable body' }) }

  const type = body.type as string | undefined
  if (type && !/email\.received|inbound\.email/i.test(type)) {
    return NextResponse.json({ ok: true, ignored: 'not inbound email' })
  }

  const data = (body.data ?? body) as Record<string, unknown>
  const resendId = (data.email_id as string) ?? (data.id as string) ?? null

  // The webhook is metadata-only; fetch the full body unless it's inline.
  let email = extractEmail(data)
  if (!email.text && !email.html) {
    if (!resendId) return NextResponse.json({ ok: true, ignored: 'no body / id' })
    const fetched = await fetchReceivedEmail(resendId)
    if (fetched.error || !fetched.email) return NextResponse.json({ ok: true, ignored: `fetch: ${fetched.error}` })
    email = fetched.email
  }

  try {
    const result = await ingestRemittance(email, resendId)
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ ok: true, error: e instanceof Error ? e.message : String(e) })
  }
}
