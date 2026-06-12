import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: p } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (p?.role !== 'admin') return null
  return user
}

function adminDb() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function GET(req: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const weekStart = req.nextUrl.searchParams.get('weekStart')
  if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return NextResponse.json({ error: 'weekStart required (YYYY-MM-DD)' }, { status: 400 })
  }

  const weekEndDate = new Date(weekStart + 'T00:00:00')
  weekEndDate.setDate(weekEndDate.getDate() + 6)
  const weekEnd = weekEndDate.toISOString().slice(0, 10)

  const db = adminDb()

  // 1. Load profiles: sf_technician_id ↔ UUID
  const { data: profiles } = await db
    .from('profiles')
    .select('id, full_name, sf_technician_id, weekly_bonus')
    .eq('role', 'technician')
    .eq('is_active', true)

  const sfIdToProfile = new Map<string, { id: string; full_name: string; weekly_bonus: number }>()
  const uuidToSfId = new Map<string, string>()
  for (const p of profiles ?? []) {
    if (p.sf_technician_id) {
      sfIdToProfile.set(String(p.sf_technician_id), {
        id: p.id,
        full_name: p.full_name,
        weekly_bonus: (p.weekly_bonus as number) ?? 0,
      })
      uuidToSfId.set(p.id, String(p.sf_technician_id))
    }
  }

  // 2. Piecework submissions for the week (source of truth for labor + revenue)
  const { data: pwJobs } = await db
    .from('jobs')
    .select('tech_id, sf_job_id, total_pay')
    .eq('week_start_date', weekStart)

  // Collect SF job IDs referenced by piecework (any week they were completed)
  const pwSfJobIds = [...new Set(
    (pwJobs ?? []).map(j => j.sf_job_id as string | null).filter((id): id is string => id !== null)
  )]

  // 3. Look up revenue for piecework-linked SF jobs — no date filter,
  //    matching detail page logic (piecework can reference prior-week jobs)
  const sfRevenueById = new Map<string, number>()
  if (pwSfJobIds.length > 0) {
    const { data: sfLookup } = await db
      .from('sf_jobs_cache')
      .select('id, total_amount')
      .in('id', pwSfJobIds)
    for (const j of sfLookup ?? []) {
      sfRevenueById.set(j.id as string, (j.total_amount as number) ?? 0)
    }
  }

  // 4. Aggregate piecework revenue + labor per SF tech ID
  type TechAgg = { sfJobIds: Set<string>; revenue: number; labor: number }
  const byTech = new Map<string, TechAgg>()

  for (const pw of pwJobs ?? []) {
    const sfTechId = uuidToSfId.get(pw.tech_id as string)
    if (!sfTechId) continue
    if (!byTech.has(sfTechId)) byTech.set(sfTechId, { sfJobIds: new Set(), revenue: 0, labor: 0 })
    const agg = byTech.get(sfTechId)!
    agg.labor += (pw.total_pay as number) ?? 0
    if (pw.sf_job_id) {
      agg.sfJobIds.add(pw.sf_job_id as string)
      agg.revenue += sfRevenueById.get(pw.sf_job_id as string) ?? 0
    }
  }

  // 5. Also include SF jobs completed this week (for techs with no piecework,
  //    and to count SF-only jobs not yet in piecework).
  //    Exclude jobs with no customer_id — those are SF internal/template records
  //    that have no real customer and should not be attributed to technicians.
  const { data: weekSfJobs } = await db
    .from('sf_jobs_cache')
    .select('id, total_amount')
    .eq('is_closed', true)
    .gte('completed_at', weekStart + 'T00:00:00')
    .lte('completed_at', weekEnd + 'T23:59:59')
    .not('completed_at', 'is', null)
    .not('customer_id', 'is', null)
    .neq('customer_id', '')

  const weekSfJobIds = (weekSfJobs ?? []).map(j => j.id as string)
  const weekSfJobMap = new Map((weekSfJobs ?? []).map(j => [j.id as string, j]))

  if (weekSfJobIds.length > 0) {
    const { data: assignments } = await db
      .from('sf_job_techs_cache')
      .select('sf_job_id, sf_tech_id')
      .in('sf_job_id', weekSfJobIds)

    for (const a of assignments ?? []) {
      const sfTechId = a.sf_tech_id as string
      if (!byTech.has(sfTechId)) byTech.set(sfTechId, { sfJobIds: new Set(), revenue: 0, labor: 0 })
      const agg = byTech.get(sfTechId)!
      const jobId = a.sf_job_id as string
      if (!agg.sfJobIds.has(jobId)) {
        // Only add jobs not already counted via piecework
        agg.sfJobIds.add(jobId)
        agg.revenue += (weekSfJobMap.get(jobId)?.total_amount as number) ?? 0
      }
    }
  }

  // 6. Build result rows
  const rows = Array.from(byTech.entries()).map(([sfTechId, agg]) => {
    const profile = sfIdToProfile.get(sfTechId)
    const bonus = profile?.weekly_bonus ?? 0
    const pieceworkPay = agg.labor > 0 ? agg.labor + bonus : (bonus > 0 ? bonus : null)
    const profit = pieceworkPay !== null ? agg.revenue - pieceworkPay : null
    const marginPct = profit !== null && agg.revenue > 0
      ? (profit / agg.revenue) * 100
      : null

    return {
      techId: sfTechId,
      techName: profile?.full_name ?? null,
      sfJobs: agg.sfJobIds.size,
      sfRevenue: agg.revenue,
      avgTicket: agg.sfJobIds.size > 0 ? agg.revenue / agg.sfJobIds.size : 0,
      pieceworkPay,
      profit,
      marginPct,
    }
  }).sort((a, b) => b.sfRevenue - a.sfRevenue)

  return NextResponse.json({ weekStart, weekEnd, rows })
}
