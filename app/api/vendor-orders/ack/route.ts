import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { markGenieActionDone } from '@/lib/vendor-orders/action-items'

export const dynamic = 'force-dynamic'

// POST { leadId } — mark a Genie action item Done (session-authed, admin+sales).
// `leadId` is the vendor_orders id (named leadId to reuse the shared DoneButton).
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { data: profile } = await supabase.from('profiles').select('role, is_active, full_name').eq('id', user.id).single()
  if (!profile?.is_active || !['admin', 'sales'].includes(profile.role ?? '')) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  let body: { leadId?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }) }
  if (!body.leadId) return NextResponse.json({ error: 'leadId required' }, { status: 400 })

  await markGenieActionDone(body.leadId, profile.full_name ?? null)
  return NextResponse.json({ ok: true })
}
