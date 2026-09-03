import { NextRequest, NextResponse } from 'next/server'
import { checkInboundSecret, extractEmail, fetchReceivedEmail, fetchAttachmentBytes } from '@/lib/inbound/resend'
import { ingestDcReport } from '@/lib/clopay-dc/ingest'

export const maxDuration = 120

// Inbound weekly Clopay DC report (via Resend Inbound) — the DC's Monday email is
// auto-forwarded to clopay@updates.castlegaragedoors.com. Guarded by a shared secret
// (?token= or x-clopay-dc-secret), and always returns 200 so a bad parse never triggers a
// retry storm from Resend; a bad token is the one hard failure. Mirrors
// app/api/remittance/inbound/route.ts.
//
// Unlike remittance and leadgen, the payload here is an ATTACHMENT, not the email body.

async function pdfTextFrom(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(bytes)
  const { text } = await extractText(pdf, { mergePages: true })
  return typeof text === 'string' ? text : String(text ?? '')
}

export async function POST(req: NextRequest) {
  if (!checkInboundSecret(req, 'CLOPAY_DC_INBOUND_SECRET', 'x-clopay-dc-secret')) {
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

  // The webhook is metadata-only; the attachment lives on the full message.
  let email = extractEmail(data)
  if (!(email.attachments ?? []).length) {
    if (!resendId) return NextResponse.json({ ok: true, ignored: 'no attachment / id' })
    const fetched = await fetchReceivedEmail(resendId)
    if (fetched.error || !fetched.email) return NextResponse.json({ ok: true, ignored: `fetch: ${fetched.error}` })
    email = fetched.email
  }

  const pdf = (email.attachments ?? []).find(a =>
    /pdf/i.test(a.contentType ?? '') || /\.pdf$/i.test(a.filename ?? ''))
  if (!pdf) {
    return NextResponse.json({ ok: true, ignored: 'no PDF attachment', from: email.from, subject: email.subject })
  }

  let bytes: Uint8Array | null = pdf.content ? new Uint8Array(Buffer.from(pdf.content, 'base64')) : null
  if (!bytes && pdf.url) bytes = await fetchAttachmentBytes(pdf.url)
  if (!bytes || bytes.byteLength === 0) {
    return NextResponse.json({ ok: true, ignored: 'attachment had no readable content' })
  }

  let text: string
  try {
    text = await pdfTextFrom(bytes)
  } catch (e) {
    return NextResponse.json({ ok: true, error: `pdf extract: ${e instanceof Error ? e.message : String(e)}` })
  }

  try {
    const result = await ingestDcReport({ text, resendEmailId: resendId, source: 'email' })
    // Keep the PDF itself for audit, but never let a storage hiccup lose the ingest.
    if (result.ok && result.status === 'ingested' && result.reportId) {
      await storeDcPdf(result.reportId, result.reportDate ?? 'unknown', pdf.filename, bytes).catch(() => {})
    }
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ ok: true, error: e instanceof Error ? e.message : String(e) })
  }
}

/** Park the PDF next to the vendor documents. Keyed by the report ROW, not the date — one
 *  Monday run can arrive as several files, and keying on the date would have them overwrite
 *  each other in storage and stamp the wrong row. Best effort. */
async function storeDcPdf(reportId: string, reportDate: string, filename: string | null, bytes: Uint8Array): Promise<void> {
  const { createClient } = await import('@supabase/supabase-js')
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const safe = (filename || 'report.pdf').replace(/[^a-zA-Z0-9._-]/g, '_')
  const path = `clopay-dc-reports/${reportDate}-${reportId.slice(0, 8)}-${safe}`
  await db.storage.from('vendor-order-attachments').upload(path, bytes, { contentType: 'application/pdf', upsert: true })
  await db.from('clopay_dc_reports').update({ storage_path: path }).eq('id', reportId)
}
