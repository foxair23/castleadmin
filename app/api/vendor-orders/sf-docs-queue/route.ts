import { NextRequest, NextResponse } from 'next/server'
import { getSfDocumentQueue } from '@/lib/sf-documents/queue'

export const dynamic = 'force-dynamic'

// GET — files the browser extension should upload onto SF jobs (signed e-sign forms).
// Same shared-token guard and CORS as the other extension queues; public in proxy.ts
// under /api/vendor-orders/. Each item carries a one-hour download URL for the bytes.
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
  const { items } = await getSfDocumentQueue(limit)
  return NextResponse.json({ items }, { headers: cors })
}
