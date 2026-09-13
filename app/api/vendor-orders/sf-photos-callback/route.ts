import { NextRequest, NextResponse } from 'next/server'
import { agentDb } from '@/lib/agent/settings'
import { recordPhotoFetchResult } from '@/lib/reputation/photo-queue'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// POST { id, photo: { name, sourceRef, contentType, base64 } } — one picture from the job page.
// POST { id, discovery }                                       — what the extension saw (no picture).
// POST { id, done: { ok, received, noPictures?, error? } }     — end of this job.
// One picture per request keeps every call under the request-size limit.
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
  let b: { id?: string; photo?: { name?: string | null; sourceRef?: string; contentType?: string | null; base64?: string }; discovery?: unknown; done?: { ok?: boolean; received?: number; noPictures?: boolean; error?: string | null } }
  try { b = await req.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400, headers: cors }) }
  if (!b.id) return NextResponse.json({ error: 'id required' }, { status: 400, headers: cors })
  const photo = b.photo && typeof b.photo.base64 === 'string' && b.photo.base64
    ? { name: b.photo.name ?? null, sourceRef: b.photo.sourceRef || b.photo.name || `photo-${Date.now()}`, contentType: b.photo.contentType ?? null, base64: b.photo.base64 }
    : undefined
  const done = b.done ? { ok: !!b.done.ok, received: b.done.received, noPictures: !!b.done.noPictures, error: b.done.error ?? null } : undefined
  const res = await recordPhotoFetchResult(agentDb(), { id: b.id, photo, discovery: b.discovery, done })
  return NextResponse.json(res, { status: res.ok ? 200 : 400, headers: cors })
}
