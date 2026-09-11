import { NextRequest, NextResponse } from 'next/server'
import { ackCommand } from '@/lib/ops/extension-report'

export const dynamic = 'force-dynamic'

// POST { id, ok, result? } — the extension closing out a command it was handed.
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
  let b: { id?: string; ok?: boolean; result?: unknown }
  try { b = await req.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400, headers: cors }) }
  if (!b.id || !/^[0-9a-f-]{36}$/i.test(b.id)) return NextResponse.json({ error: 'id required' }, { status: 400, headers: cors })
  const res = await ackCommand(b.id, !!b.ok, b.result)
  return NextResponse.json(res, { headers: cors })
}
