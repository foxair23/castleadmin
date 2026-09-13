import { NextRequest, NextResponse } from 'next/server'
import { agentDb } from '@/lib/agent/settings'
import { getPhotoFetchQueue } from '@/lib/reputation/photo-queue'

export const dynamic = 'force-dynamic'

// GET — jobs whose pictures the browser extension should pull from Service Fusion's
// web session (its API has no file endpoint). Same shared-token guard and CORS as the
// other extension queues; public in proxy.ts under /api/vendor-orders/.
function authed(req: NextRequest): boolean {
  const token = process.env.REMITTANCE_APPLY_TOKEN
  if (!token) return false
  const got = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || req.headers.get('x-remittance-token')
  return got === token
}
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-remittance-token, content-type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }
export function OPTIONS() { return new NextResponse(null, { status: 204, headers: cors }) }

export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: cors })
  const limit = Math.min(Number(req.nextUrl.searchParams.get('limit') ?? 10) || 10, 50)
  const { items } = await getPhotoFetchQueue(agentDb(), limit)
  return NextResponse.json({ items }, { headers: cors })
}
