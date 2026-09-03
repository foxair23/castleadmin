import { fetchReceivedAttachments } from '@/lib/inbound/resend'
import { ingestDcReport, type DcIngestResult } from './ingest'

// Turn one forwarded DC-report email into an ingest. Kept out of the webhook route so the
// route stays a dispatcher and this can be exercised directly.

async function pdfText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(bytes)
  const { text } = await extractText(pdf, { mergePages: true })
  return typeof text === 'string' ? text : String(text ?? '')
}

/** Fetch EVERY PDF on the email and ingest each one. A Monday run arrives as several files —
 *  the 31-Aug run was two PDFs — and they can land as separate forwards or as one forward
 *  carrying both. Reading only the first attachment would silently ingest half a run. */
export async function ingestDcReportEmail(
  resendId: string | null, subject: string | null,
): Promise<DcIngestResult & { attachments?: number; files?: Array<{ filename: string; status: string; rows?: number; error?: string }> }> {
  if (!resendId) return { ok: false, status: 'parse_failed', error: 'no email id' }

  const atts = await fetchReceivedAttachments(resendId)
  const pdfs = atts.filter(a => /pdf/i.test(a.contentType) || /\.pdf$/i.test(a.filename))
  if (!pdfs.length) {
    return { ok: false, status: 'parse_failed', attachments: atts.length, error: `no PDF attachment (subject: ${subject ?? '—'})` }
  }

  const files: Array<{ filename: string; status: string; rows?: number; error?: string }> = []
  let rows = 0, newPos = 0, linked = 0, anyOk = false, reportDate: string | undefined

  for (const pdf of pdfs) {
    const bytes = new Uint8Array(Buffer.from(pdf.base64, 'base64'))
    let text: string
    try {
      text = await pdfText(bytes)
    } catch (e) {
      files.push({ filename: pdf.filename, status: 'extract_failed', error: e instanceof Error ? e.message : String(e) })
      continue
    }

    // Key each ATTACHMENT, not each email: two files on one forward are two reports, and
    // keying both on the email id would make the second overwrite the first.
    const result = await ingestDcReport({ text, resendEmailId: `${resendId}#${pdf.filename}`, source: 'email' })
    files.push({ filename: pdf.filename, status: result.status, rows: result.rows, error: result.error })
    if (result.ok) {
      anyOk = true
      rows += result.rows ?? 0
      newPos += result.newPos ?? 0
      linked += result.linked ?? 0
      reportDate = result.reportDate ?? reportDate
      if (result.status === 'ingested' && result.reportId) {
        await storePdf(result.reportId, result.reportDate ?? 'unknown', pdf.filename, bytes).catch(() => {})
      }
    }
  }

  return {
    ok: anyOk,
    status: anyOk ? 'ingested' : 'parse_failed',
    reportDate, rows, linked, newPos,
    attachments: atts.length,
    files,
    ...(anyOk ? {} : { error: files.map(f => `${f.filename}: ${f.error ?? f.status}`).join('; ') }),
  }
}

/** Park the PDF for audit, keyed by the report ROW — one run can be several files, so a
 *  date-based key would have them overwrite each other. Best effort. */
async function storePdf(reportId: string, reportDate: string, filename: string, bytes: Uint8Array): Promise<void> {
  const { createClient } = await import('@supabase/supabase-js')
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const safe = (filename || 'report.pdf').replace(/[^a-zA-Z0-9._-]/g, '_')
  const path = `clopay-dc-reports/${reportDate}-${reportId.slice(0, 8)}-${safe}`
  await db.storage.from('vendor-order-attachments').upload(path, bytes, { contentType: 'application/pdf', upsert: true })
  await db.from('clopay_dc_reports').update({ storage_path: path }).eq('id', reportId)
}
