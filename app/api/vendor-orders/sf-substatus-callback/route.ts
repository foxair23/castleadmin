import { NextRequest, NextResponse } from 'next/server'
import { recordSubStatusResult } from '@/lib/esign/sub-status'

export const dynamic = 'force-dynamic'

// POST { id, ok, error?, subStatus? } — the extension reporting one sub-status write.
// `subStatus` is what SF echoed back on success, which is the receipt we record.
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
  let b: { id?: string; ok?: boolean; error?: string; subStatus?: string }
  try { b = await req.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400, headers: cors }) }
  if (!b.id) return NextResponse.json({ error: 'id required' }, { status: 400, headers: cors })
  const res = await recordSubStatusResult(b.id, { ok: b.ok, error: b.error, subStatus: b.subStatus })
  return NextResponse.json(res, { status: res.ok ? 200 : 400, headers: cors })
}
