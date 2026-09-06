import { NextRequest, NextResponse } from 'next/server'
import { getSfLinesQueue } from '@/lib/vendor-orders/sf-lines-queue'

export const dynamic = 'force-dynamic'

// GET — IPO line items the browser extension should post onto existing SF jobs.
//
// Service Fusion's API cannot modify a job that already exists (PUT /jobs → 405), so this
// mirrors the remittance apply queue: the app decides what to post, the extension posts it
// through SF's logged-in web session. Same shared-token guard and open CORS as that route.
function authed(req: NextRequest): boolean {
  const token = process.env.REMITTANCE_APPLY_TOKEN
  if (!token) return false // must be configured to enable the extension path
  const got = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || req.headers.get('x-remittance-token')
  return got === token
}

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-remittance-token, content-type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }

export function OPTIONS() { return new NextResponse(null, { status: 204, headers: cors }) }

export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: cors })
  const limit = Math.min(Number(req.nextUrl.searchParams.get('limit') ?? 25) || 25, 100)
  const { items } = await getSfLinesQueue(limit)
  return NextResponse.json({ items }, { headers: cors })
}
