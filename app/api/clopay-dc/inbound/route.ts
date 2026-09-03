import { NextRequest, NextResponse } from 'next/server'
import { checkInboundSecret } from '@/lib/inbound/resend'
import { ingestDcReport } from '@/lib/clopay-dc/ingest'
import { ingestDcReportEmail } from '@/lib/clopay-dc/from-email'

export const maxDuration = 120

// Direct-post route for the weekly Clopay DC report.
//
// NOTE: this is NOT the path forwarded email takes. One Resend webhook serves the whole
// @updates.castlegaragedoors.com domain — app/api/leads/inbound/route.ts — and it routes
// clopay@ to the same ingest. This route exists for the cases that route cannot serve:
// re-ingesting a stored PDF after a parser fix, and exercising the ingest without sending
// mail. Guarded by the same shared secret (?token= or x-clopay-dc-secret).
//
// POST one of:
//   { resendEmailId } — replay an email Resend already received, pulling its PDF back out of
//                       the Received Emails API. This is how reports that reached the webhook
//                       but were mis-routed get ingested without asking anyone to forward
//                       them again.
//   { dataB64 }       — a PDF.
//   { text }          — already-extracted text (what clopay_dc_reports keeps in raw_text, so
//                       a parser fix can be replayed against past reports).
export async function POST(req: NextRequest) {
  if (!checkInboundSecret(req, 'CLOPAY_DC_INBOUND_SECRET', 'x-clopay-dc-secret')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { resendEmailId?: string; dataB64?: string; text?: string; reportDate?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }) }

  if (body.resendEmailId) {
    return NextResponse.json(await ingestDcReportEmail(body.resendEmailId, null))
  }

  let text = body.text ?? ''
  if (!text && body.dataB64) {
    try {
      const { extractText, getDocumentProxy } = await import('unpdf')
      const pdf = await getDocumentProxy(new Uint8Array(Buffer.from(body.dataB64, 'base64')))
      const out = await extractText(pdf, { mergePages: true })
      text = typeof out.text === 'string' ? out.text : String(out.text ?? '')
    } catch (e) {
      return NextResponse.json({ ok: false, error: `pdf extract: ${e instanceof Error ? e.message : String(e)}` }, { status: 400 })
    }
  }
  if (!text.trim()) return NextResponse.json({ error: 'dataB64 or text required' }, { status: 400 })

  const result = await ingestDcReport({ text, reportDate: body.reportDate ?? null, source: 'manual' })
  return NextResponse.json(result)
}
