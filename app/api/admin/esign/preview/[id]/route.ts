import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { previewEsignDoc } from '@/lib/esign/prepare'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// GET — the blank (pre-filled where a template exists) with every template box outlined and
// a coordinate ruler: the picture a layout is pinned from. Admin-only; served inline so it
// opens in the browser's PDF viewer. `?fields=<json>` previews a candidate layout before it
// is registered (an array of FieldSpec; only `key` and `box` matter for the overlay).
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') return NextResponse.json({ error: 'admin only' }, { status: 403 })

  const { id } = await ctx.params
  let candidate: { fields: Array<{ key: string; kind: 'text'; source: 'today'; box: { page: number; x: number; y: number; w: number; h: number } }> } | undefined
  const raw = req.nextUrl.searchParams.get('fields')
  if (raw) {
    try {
      const arr = JSON.parse(raw) as Array<{ key?: string; box?: { page?: number; x?: number; y?: number; w?: number; h?: number } }>
      candidate = { fields: arr.filter(f => f && f.key && f.box).map(f => ({ key: String(f.key), kind: 'text' as const, source: 'today' as const, box: { page: Number(f.box!.page ?? 0), x: Number(f.box!.x), y: Number(f.box!.y), w: Number(f.box!.w), h: Number(f.box!.h) } })) }
    } catch { return NextResponse.json({ error: 'fields must be JSON' }, { status: 400 }) }
  }
  const r = await previewEsignDoc(id, candidate)
  if (!r.ok || !r.bytes) return NextResponse.json({ error: r.error ?? 'preview failed' }, { status: 404 })
  return new NextResponse(Buffer.from(r.bytes), { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="esign-preview-${id}.pdf"`, 'Cache-Control': 'no-store' } })
}
