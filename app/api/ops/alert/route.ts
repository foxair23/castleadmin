import { NextRequest, NextResponse } from 'next/server'
import { sendAutomationAlert } from '@/lib/ops/alert'

export const dynamic = 'force-dynamic'

// POST { source, kind?, detail? } — the browser extension reports an automation
// problem (site logged out, crawl failed, post failed); we email the chosen
// recipients (deduped). Same shared-token guard + open CORS as the other
// extension endpoints.
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
  let body: { source?: string; kind?: 'logged_out' | 'error'; detail?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400, headers: cors }) }
  if (!body.source) return NextResponse.json({ error: 'source required' }, { status: 400, headers: cors })
  const res = await sendAutomationAlert({ source: body.source, kind: body.kind, detail: body.detail })
  return NextResponse.json(res, { status: res.ok ? 200 : 400, headers: cors })
}
