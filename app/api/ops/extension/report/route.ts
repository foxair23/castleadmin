import { NextRequest, NextResponse } from 'next/server'
import { recordExtensionReport } from '@/lib/ops/extension-report'

export const dynamic = 'force-dynamic'

// POST — the office extension reporting a run, crawl, login, warm-up or heartbeat. The
// response carries any commands queued from the Health page. Same shared-token guard
// and open CORS as the other extension endpoints; public in proxy.ts under /api/ops/.
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
  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400, headers: cors }) }
  const res = await recordExtensionReport(body)
  return NextResponse.json(res, { status: res.ok ? 200 : 400, headers: cors })
}
