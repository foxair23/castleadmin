import { NextRequest, NextResponse } from 'next/server'
import { recordSfDocumentResult, reportSfDocumentRunFailures } from '@/lib/sf-documents/queue'

export const dynamic = 'force-dynamic'

// POST { id, ok, error?, sfResponse? }  — the extension reporting one upload.
// POST { id, discovery }                 — what it found on the SF page (no upload made).
// POST { runFailures: [{ id, error }] }  — end of run: the office gets one list to do by hand.
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
  let b: { id?: string; ok?: boolean; error?: string; discovery?: unknown; sfResponse?: unknown; runFailures?: Array<{ id: string; error?: string | null }> }
  try { b = await req.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400, headers: cors }) }
  if (Array.isArray(b.runFailures)) {
    const res = await reportSfDocumentRunFailures(b.runFailures.filter(f => f && typeof f.id === 'string'))
    return NextResponse.json(res, { headers: cors })
  }
  if (!b.id) return NextResponse.json({ error: 'id required' }, { status: 400, headers: cors })
  const res = await recordSfDocumentResult(b.id, { ok: b.ok, error: b.error, discovery: b.discovery, sfResponse: b.sfResponse })
  return NextResponse.json(res, { status: res.ok ? 200 : 400, headers: cors })
}
