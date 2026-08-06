import { NextRequest, NextResponse } from 'next/server'
import { getApplyQueue } from '@/lib/remittance/apply-queue'

export const dynamic = 'force-dynamic'

// GET — approved remittance lines the browser extension should post to SF.
// Guarded by a shared token (the extension stores it): Authorization: Bearer …
// or x-remittance-token. CORS-open so the extension (different origin) can read.
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
  const { items, skipped } = await getApplyQueue()
  return NextResponse.json({ items, skipped }, { headers: cors })
}
