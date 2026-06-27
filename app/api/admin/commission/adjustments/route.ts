import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { requireCommissionAdmin } from '@/lib/commission/admin-auth'
import { recomputeSnapshots } from '@/lib/commission/engine'

export const maxDuration = 300

// POST { tech_user_id, period_start, period_end, amount, note } — add a signed
// manual adjustment to a tech's period (§4.7). A note is required.
export async function POST(req: NextRequest) {
  const admin = await requireCommissionAdmin()
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { tech_user_id, period_start, period_end, amount, note } = await req.json()
  if (!tech_user_id || !period_start || !period_end) {
    return NextResponse.json({ error: 'tech and period required' }, { status: 400 })
  }
  const amt = Number(amount)
  if (!isFinite(amt) || amt === 0) {
    return NextResponse.json({ error: 'A non-zero amount is required' }, { status: 400 })
  }
  if (!note || !String(note).trim()) {
    return NextResponse.json({ error: 'A note is required' }, { status: 400 })
  }

  const db = await createServiceClient()
  const { error } = await db.from('commission_adjustments').insert({
    tech_user_id, period_start, period_end,
    amount: amt, note: String(note).trim(), created_by: admin.id,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await recomputeSnapshots()
  return NextResponse.json({ ok: true })
}

// DELETE ?id= — remove an adjustment.
export async function DELETE(req: NextRequest) {
  const admin = await requireCommissionAdmin()
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const db = await createServiceClient()
  const { error } = await db.from('commission_adjustments').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await recomputeSnapshots()
  return NextResponse.json({ ok: true })
}
