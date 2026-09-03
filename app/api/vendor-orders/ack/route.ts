import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { markGenieActionDone, markDcPoScheduled } from '@/lib/vendor-orders/action-items'

export const dynamic = 'force-dynamic'

// POST { leadId, kind? } — mark an action item Done (session-authed, admin+sales).
// `leadId` is named that way to reuse the shared DoneButton. What it identifies depends on
// the kind: for everything except a Clopay DC arrival it is the vendor_orders id, but an
// 'at_dc' item dismisses against clopay_dc_po_state and its id is the PO key — Castle-direct
// rows have no vendor_orders row at all. So the dispatch must happen before any lookup.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { data: profile } = await supabase.from('profiles').select('role, is_active, full_name').eq('id', user.id).single()
  if (!profile?.is_active || !['admin', 'sales'].includes(profile.role ?? '')) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  let body: { leadId?: string; kind?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }) }
  if (!body.leadId) return NextResponse.json({ error: 'leadId required' }, { status: 400 })

  if (body.kind === 'at_dc') await markDcPoScheduled(body.leadId, profile.full_name ?? null)
  else await markGenieActionDone(body.leadId, profile.full_name ?? null)
  return NextResponse.json({ ok: true })
}
