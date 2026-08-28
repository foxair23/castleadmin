import { NextRequest, NextResponse } from 'next/server'
import { recordVendorAttachment } from '@/lib/vendor-orders/attachments'

export const dynamic = 'force-dynamic'

// POST { vendor, external_id, documentId, path, filename, mime, size } — the extension
// calls this after PUTting the document bytes to the signed upload URL, to record the
// attachment row. Deduped by (order, documentId) at the DB level.
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
  let b: { vendor?: string; external_id?: string; documentId?: string | number; path?: string; filename?: string; mime?: string; size?: number }
  try { b = await req.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400, headers: cors }) }
  if (!b.vendor || !b.external_id || b.documentId == null || !b.path) return NextResponse.json({ error: 'vendor, external_id, documentId, path required' }, { status: 400, headers: cors })
  const res = await recordVendorAttachment(b.vendor, b.external_id, String(b.documentId), b.path, b.filename || 'document', b.mime || 'application/pdf', b.size ?? 0)
  return NextResponse.json(res, { status: res.ok ? 200 : 400, headers: cors })
}
