import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { requireCommissionAdmin } from '@/lib/commission/admin-auth'

// Commission disbursement ledger. Unlike adjustments, payments DON'T affect the
// commission calculation — they only record money paid out — so there is no
// recompute here.

// POST { tech_user_id, period_start, period_end, amount, paid_on, method?, note? }
// — log a payment to a tech for a period. Amount must be positive.
export async function POST(req: NextRequest) {
  const admin = await requireCommissionAdmin()
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { tech_user_id, period_start, period_end, amount, paid_on, method, note } = await req.json()
  if (!tech_user_id || !period_start || !period_end) {
    return NextResponse.json({ error: 'tech and period required' }, { status: 400 })
  }
  if (!paid_on) return NextResponse.json({ error: 'A payment date is required' }, { status: 400 })
  const amt = Number(amount)
  if (!isFinite(amt) || amt <= 0) {
    return NextResponse.json({ error: 'A positive amount is required' }, { status: 400 })
  }

  const db = await createServiceClient()
  const { error } = await db.from('commission_payments').insert({
    tech_user_id, period_start, period_end,
    amount: amt,
    paid_on,
    method: method && String(method).trim() ? String(method).trim() : null,
    note: note && String(note).trim() ? String(note).trim() : null,
    created_by: admin.id,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

// DELETE ?id= — remove a payment (correction).
export async function DELETE(req: NextRequest) {
  const admin = await requireCommissionAdmin()
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const db = await createServiceClient()
  const { error } = await db.from('commission_payments').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
