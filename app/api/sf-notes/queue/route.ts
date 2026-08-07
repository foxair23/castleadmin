import { NextRequest, NextResponse } from 'next/server'
import { getNoteQueue } from '@/lib/sf-notes/queue'

export const dynamic = 'force-dynamic'

// GET — pending SF job notes the browser extension should post. Guarded by the
// same shared token as the remittance apply flow (the extension already stores
// it): Authorization: Bearer … or x-remittance-token. CORS-open so the
// extension (different origin) can read it.
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
  const { items } = await getNoteQueue()
  return NextResponse.json({ items }, { headers: cors })
}
