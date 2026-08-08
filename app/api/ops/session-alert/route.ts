import { NextRequest, NextResponse } from 'next/server'
import { alertSessionLoggedOut } from '@/lib/ops/session-alert'

export const dynamic = 'force-dynamic'

// POST { site: 'service_fusion' | 'genie' } — the browser extension reports a
// site logged out; we email the chosen recipients (deduped). Same shared-token
// guard + open CORS as the other extension endpoints.
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
  let body: { site?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400, headers: cors }) }
  if (!body.site) return NextResponse.json({ error: 'site required' }, { status: 400, headers: cors })
  const res = await alertSessionLoggedOut(body.site)
  return NextResponse.json(res, { status: res.ok ? 200 : 400, headers: cors })
}
