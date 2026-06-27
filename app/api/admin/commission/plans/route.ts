import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { requireCommissionAdmin } from '@/lib/commission/admin-auth'
import { recomputeSnapshots } from '@/lib/commission/engine'
import { ACTIVE_PERIOD_TYPE } from '@/lib/commission/periods'

export const maxDuration = 300

// GET ?period_start=&period_end= — per-tech plan + eligible/collected revenue
// for the period, so the admin sees the effect of the numbers they enter (§6).
export async function GET(req: NextRequest) {
  const admin = await requireCommissionAdmin()
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const period_start = req.nextUrl.searchParams.get('period_start')
  const period_end = req.nextUrl.searchParams.get('period_end')
  if (!period_start || !period_end) {
    return NextResponse.json({ error: 'period_start and period_end required' }, { status: 400 })
  }

  const db = await createServiceClient()

  const [{ data: techs }, { data: plans }, { data: elig }] = await Promise.all([
    db.from('profiles').select('id, full_name').eq('role', 'technician').eq('is_active', true).order('full_name'),
    db.from('commission_plans')
      .select('tech_user_id, sales_target, rate_below, rate_above')
      .eq('period_start', period_start).eq('period_end', period_end),
    db.from('commission_job_eligibility')
      .select('tech_user_id, revenue, revenue_frozen')
      .eq('status', 'eligible')
      .not('tech_user_id', 'is', null)
      .gte('recognition_date', period_start)
      .lte('recognition_date', period_end),
  ])

  const planByTech = new Map(
    (plans ?? []).map(p => [p.tech_user_id, p]),
  )

  const revByTech = new Map<string, { eligible: number; collected: number }>()
  for (const e of (elig ?? []) as Array<{ tech_user_id: string; revenue: number; revenue_frozen: boolean }>) {
    const cur = revByTech.get(e.tech_user_id) ?? { eligible: 0, collected: 0 }
    cur.eligible += e.revenue ?? 0
    if (e.revenue_frozen) cur.collected += e.revenue ?? 0
    revByTech.set(e.tech_user_id, cur)
  }

  const rows = (techs ?? []).map(t => {
    const plan = planByTech.get(t.id)
    const rev = revByTech.get(t.id) ?? { eligible: 0, collected: 0 }
    return {
      tech_user_id: t.id,
      full_name: t.full_name,
      eligible_revenue: Math.round(rev.eligible * 100) / 100,
      collected_revenue: Math.round(rev.collected * 100) / 100,
      sales_target: plan?.sales_target ?? null,
      rate_below: plan?.rate_below ?? null,
      rate_above: plan?.rate_above ?? null,
    }
  })

  return NextResponse.json({ rows })
}

// POST — save one tech's plan for a period, or copy a whole period's plans.
//   { action: 'save', tech_user_id, period_start, period_end, sales_target, rate_below, rate_above }
//   { action: 'copy', from_start, from_end, period_start, period_end }
export async function POST(req: NextRequest) {
  const admin = await requireCommissionAdmin()
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const db = await createServiceClient()
  const now = new Date().toISOString()

  if (body.action === 'bulk') {
    // Save every changed row in one request, then recompute once.
    const { period_start, period_end, rows, clears } = body as {
      period_start: string; period_end: string
      rows: Array<{ tech_user_id: string; sales_target: number; rate_below: number; rate_above: number }>
      clears: string[]
    }
    if (!period_start || !period_end) {
      return NextResponse.json({ error: 'Missing periods' }, { status: 400 })
    }

    if (Array.isArray(rows) && rows.length > 0) {
      const upserts = rows.map(r => ({
        tech_user_id: r.tech_user_id,
        period_type: ACTIVE_PERIOD_TYPE,
        period_start, period_end,
        sales_target: r.sales_target ?? 0,
        rate_below: r.rate_below ?? 0,
        rate_above: r.rate_above ?? 0,
        created_by: admin.id,
        updated_at: now,
      }))
      const { error } = await db
        .from('commission_plans')
        .upsert(upserts, { onConflict: 'tech_user_id,period_start,period_end' })
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (Array.isArray(clears) && clears.length > 0) {
      const { error } = await db
        .from('commission_plans')
        .delete()
        .eq('period_start', period_start).eq('period_end', period_end)
        .in('tech_user_id', clears)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }

    await recomputeSnapshots()
    return NextResponse.json({ ok: true, saved: rows?.length ?? 0, cleared: clears?.length ?? 0 })
  }

  if (body.action === 'copy') {
    const { from_start, from_end, period_start, period_end } = body
    if (!from_start || !from_end || !period_start || !period_end) {
      return NextResponse.json({ error: 'Missing periods' }, { status: 400 })
    }
    const { data: src } = await db
      .from('commission_plans')
      .select('tech_user_id, sales_target, rate_below, rate_above')
      .eq('period_start', from_start).eq('period_end', from_end)
    const rows = (src ?? []).map(p => ({
      tech_user_id: p.tech_user_id,
      period_type: ACTIVE_PERIOD_TYPE,
      period_start, period_end,
      sales_target: p.sales_target,
      rate_below: p.rate_below,
      rate_above: p.rate_above,
      created_by: admin.id,
      updated_at: now,
    }))
    if (rows.length > 0) {
      const { error } = await db
        .from('commission_plans')
        .upsert(rows, { onConflict: 'tech_user_id,period_start,period_end' })
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }
    await recomputeSnapshots()
    return NextResponse.json({ ok: true, copied: rows.length })
  }

  // Default: save one row.
  const { tech_user_id, period_start, period_end, sales_target, rate_below, rate_above } = body
  if (!tech_user_id || !period_start || !period_end) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }
  const { error } = await db.from('commission_plans').upsert(
    {
      tech_user_id,
      period_type: ACTIVE_PERIOD_TYPE,
      period_start, period_end,
      sales_target: sales_target ?? 0,
      rate_below: rate_below ?? 0,
      rate_above: rate_above ?? 0,
      created_by: admin.id,
      updated_at: now,
    },
    { onConflict: 'tech_user_id,period_start,period_end' },
  )
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await recomputeSnapshots()
  return NextResponse.json({ ok: true })
}

// DELETE ?tech_user_id=&period_start=&period_end= — remove a tech's plan.
export async function DELETE(req: NextRequest) {
  const admin = await requireCommissionAdmin()
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const p = req.nextUrl.searchParams
  const tech_user_id = p.get('tech_user_id')
  const period_start = p.get('period_start')
  const period_end = p.get('period_end')
  if (!tech_user_id || !period_start || !period_end) {
    return NextResponse.json({ error: 'Missing params' }, { status: 400 })
  }
  const db = await createServiceClient()
  const { error } = await db
    .from('commission_plans')
    .delete()
    .eq('tech_user_id', tech_user_id).eq('period_start', period_start).eq('period_end', period_end)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await recomputeSnapshots()
  return NextResponse.json({ ok: true })
}
