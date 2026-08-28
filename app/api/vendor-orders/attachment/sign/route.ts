import { NextRequest, NextResponse } from 'next/server'
import { signVendorAttachmentUpload } from '@/lib/vendor-orders/attachments'

export const dynamic = 'force-dynamic'

// POST { vendor, external_id, documentId, filename } — the browser extension, while
// crawling, asks for a signed upload URL to store one order document on our storage.
// Returns { alreadyStored:true } (skip) or { uploadUrl, path } to PUT the bytes to.
// Same shared-token guard + open CORS as the ingest route.
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
  let b: { vendor?: string; external_id?: string; documentId?: string | number; filename?: string }
  try { b = await req.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400, headers: cors }) }
  if (!b.vendor || !b.external_id || b.documentId == null) return NextResponse.json({ error: 'vendor, external_id, documentId required' }, { status: 400, headers: cors })
  const res = await signVendorAttachmentUpload(b.vendor, b.external_id, String(b.documentId), b.filename || 'document')
  return NextResponse.json(res, { status: res.ok ? 200 : 400, headers: cors })
}
