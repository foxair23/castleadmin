import { NextRequest, NextResponse } from 'next/server'
import { ingestOrders, type ScrapedOrder } from '@/lib/vendor-orders/ingest'

export const dynamic = 'force-dynamic'

// POST { vendor, orders: [...] } — the browser extension posts orders scraped
// from a vendor portal (list-level for all, detail-level for new ones). Returns
// { needDetail: [...] } so the extension knows which orders to open + scrape in
// detail. Same shared-token guard + open CORS as the other extension endpoints.
function authed(req: NextRequest): boolean {
  const token = process.env.REMITTANCE_APPLY_TOKEN
  if (!token) return false
  const got = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || req.headers.get('x-remittance-token')
  return got === token
}

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-remittance-token, content-type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }

export function OPTIONS() { return new NextResponse(null, { status: 204, headers: cors }) }

export async function POST(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: cors })
  let body: { vendor?: string; orders?: ScrapedOrder[]; kind?: 'list' | 'detail'; mode?: string | null }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400, headers: cors }) }
  if (!body.vendor) return NextResponse.json({ error: 'vendor required' }, { status: 400, headers: cors })
  const res = await ingestOrders(body.vendor, body.orders ?? [], { kind: body.kind, mode: body.mode })
  return NextResponse.json(res, { status: res.ok ? 200 : 400, headers: cors })
}
