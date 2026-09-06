import { NextRequest, NextResponse } from 'next/server'
import { recordSfLinesResult } from '@/lib/vendor-orders/sf-lines-queue'

export const dynamic = 'force-dynamic'

// POST { orderId, ok, posted?, error? } — the extension reporting what happened when it
// posted one order's line items to its SF job. Idempotent: an order already marked posted
// stays posted, so a repeated callback cannot flip a success into a failure.
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
  let b: { orderId?: string; ok?: boolean; posted?: number; error?: string }
  try { b = await req.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400, headers: cors }) }
  if (!b.orderId) return NextResponse.json({ error: 'orderId required' }, { status: 400, headers: cors })
  const res = await recordSfLinesResult(b.orderId, { ok: !!b.ok, posted: b.posted, error: b.error })
  return NextResponse.json(res, { status: res.ok ? 200 : 400, headers: cors })
}
