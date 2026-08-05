import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { requireCommissionAdmin } from '@/lib/commission/admin-auth'

// Per-tech payments overview for a period: who's owed (payable), what's been
// paid, and the remaining balance. Uses the cached commission_calc_snapshots
// (commission_payable == collected commission_received) so it's cheap — no
// per-tech recompute. Run the commission Recompute if snapshots look stale.
export async function GET(req: NextRequest) {
  const admin = await requireCommissionAdmin()
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const periodStart = req.nextUrl.searchParams.get('period_start')
  const periodEnd = req.nextUrl.searchParams.get('period_end')
  if (!periodStart || !periodEnd) return NextResponse.json({ error: 'period required' }, { status: 400 })

  const db = await createServiceClient()
  const [{ data: techData }, { data: snapData }, { data: payData }] = await Promise.all([
    db.from('profiles').select('id, full_name').eq('role', 'technician').eq('is_active', true),
    db.from('commission_calc_snapshots').select('tech_user_id, commission_payable').eq('period_start', periodStart).eq('period_end', periodEnd),
    db.from('commission_payments').select('tech_user_id, amount').eq('period_start', periodStart).eq('period_end', periodEnd),
  ])

  const payableByTech = new Map<string, number>()
  for (const s of snapData ?? []) payableByTech.set(s.tech_user_id as string, Number(s.commission_payable) || 0)
  const paidByTech = new Map<string, number>()
  for (const p of payData ?? []) paidByTech.set(p.tech_user_id as string, (paidByTech.get(p.tech_user_id as string) ?? 0) + (Number(p.amount) || 0))

  // Union: active techs, plus anyone with a snapshot or a payment this period
  // (e.g. a paid-then-deactivated tech still shows their balance).
  const names = new Map<string, string>()
  for (const t of techData ?? []) names.set(t.id as string, (t.full_name as string) ?? '')
  const ids = new Set<string>([...names.keys(), ...payableByTech.keys(), ...paidByTech.keys()])
  const missing = [...ids].filter(id => !names.has(id))
  if (missing.length) {
    const { data: extra } = await db.from('profiles').select('id, full_name').in('id', missing)
    for (const t of extra ?? []) names.set(t.id as string, (t.full_name as string) ?? '')
  }

  const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
  const rows = [...ids].map(id => {
    const payable = round2(payableByTech.get(id) ?? 0)
    const paid_total = round2(paidByTech.get(id) ?? 0)
    return { tech_user_id: id, full_name: names.get(id) ?? '—', payable, paid_total, balance: round2(payable - paid_total) }
  }).sort((a, b) => b.balance - a.balance || a.full_name.localeCompare(b.full_name))

  return NextResponse.json({ rows })
}
