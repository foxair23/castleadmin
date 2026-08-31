import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { storeVendorDoc } from '@/lib/vendor-orders/attachments'
import { isIpoDoc } from '@/lib/vendor-orders/clopay-ipo'

export const dynamic = 'force-dynamic'

// POST { vendor, external_id, documentId, filename, mime, dataB64? } — the extension's
// content script downloads a document in the page context (where the Clopay session
// cookie is present) and sends the base64 bytes here to store. With no dataB64 it's a
// cheap dedup check (so already-stored docs aren't re-downloaded). Same shared-token
// guard + open CORS as the ingest route. Small PDFs, well under the Vercel body cap.
function authed(req: NextRequest): boolean {
  const token = process.env.REMITTANCE_APPLY_TOKEN
  if (!token) return false
  const got = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || req.headers.get('x-remittance-token')
  return got === token
}
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-remittance-token, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }
export function OPTIONS() { return new NextResponse(null, { status: 204, headers: cors }) }

export async function POST(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: cors })
  let b: { vendor?: string; external_id?: string; documentId?: string | number; filename?: string; mime?: string; dataB64?: string }
  try { b = await req.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400, headers: cors }) }
  if (!b.vendor || !b.external_id || b.documentId == null) return NextResponse.json({ error: 'vendor, external_id, documentId required' }, { status: 400, headers: cors })
  const bytes = b.dataB64 ? new Uint8Array(Buffer.from(b.dataB64, 'base64')) : null
  const res = await storeVendorDoc(b.vendor, b.external_id, String(b.documentId), b.filename || 'document', b.mime || 'application/pdf', bytes)

  // An IPO carries the line-item detail + what we get paid. Parse it into structured rows
  // AFTER responding, so the extension's doc sync is never slowed or broken by parsing.
  if (res.ok && res.stored && isIpoDoc(b.filename)) {
    after(async () => {
      try {
        const { parseAndStoreIpoAttachment } = await import('@/lib/vendor-orders/ipo-ingest')
        const { findAttachmentId } = await import('@/lib/vendor-orders/attachments')
        const id = await findAttachmentId(b.vendor!, b.external_id!, String(b.documentId))
        if (id) await parseAndStoreIpoAttachment(id)
      } catch (e) { console.error('[attachment/store] IPO parse failed (non-critical):', e) }
    })
  }
  return NextResponse.json(res, { status: res.ok ? 200 : 400, headers: cors })
}
