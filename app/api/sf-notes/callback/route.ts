import { NextRequest, NextResponse } from 'next/server'
import { recordNoteResult } from '@/lib/sf-notes/queue'

export const dynamic = 'force-dynamic'

// POST { id, ok, sfResponse?, error? } — the extension reports the result of
// posting one note to SF; we mark it posted/failed. Same shared-token guard as
// the queue endpoint.
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
  let body: { id?: string; ok?: boolean; sfResponse?: unknown; error?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400, headers: cors }) }
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400, headers: cors })
  const res = await recordNoteResult(body.id, { ok: !!body.ok, sfResponse: body.sfResponse, error: body.error })
  return NextResponse.json(res, { status: res.ok ? 200 : 400, headers: cors })
}
