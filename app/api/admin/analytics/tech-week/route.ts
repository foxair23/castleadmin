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

  // 1. Load all profiles with sf_technician_id
  const { data: profiles } = await db
    .from('profiles')
    .select('id, full_name, sf_technician_id')
    .eq('role', 'technician')
    .eq('is_active', true)

  // Build lookup maps
  const sfIdToProfile = new Map<string, { id: string; full_name: string }>()
  const uuidToSfId = new Map<string, string>()
  for (const p of profiles ?? []) {
    if (p.sf_technician_id) {
      sfIdToProfile.set(String(p.sf_technician_id), { id: p.id, full_name: p.full_name })
      uuidToSfId.set(p.id, String(p.sf_technician_id))
    }
  }

  // 2. Fetch closed SF jobs in the week
  const { data: sfJobs } = await db
    .from('sf_jobs_cache')
    .select('id, completed_at')
    .eq('is_closed', true)
    .gte('completed_at', weekStart + 'T00:00:00')
    .lte('completed_at', weekEnd + 'T23:59:59')
    .not('completed_at', 'is', null)

  const sfJobIds = (sfJobs ?? []).map(j => j.id as string)

  // 3. Fetch invoice totals for those jobs (revenue source of truth)
  const invoiceRevenueByJobId = new Map<string, number>()
  if (sfJobIds.length > 0) {
    const { data: invoices } = await db
      .from('sf_invoices_cache')
      .select('job_id, total')
      .in('job_id', sfJobIds)
      .not('total', 'is', null)

    for (const inv of invoices ?? []) {
      const jid = inv.job_id as string
      invoiceRevenueByJobId.set(jid, (invoiceRevenueByJobId.get(jid) ?? 0) + ((inv.total as number) ?? 0))
    }
  }

  // 4. Fetch tech assignments for those jobs
  const sfByTech: Record<string, { jobs: number; revenue: number }> = {}
  if (sfJobIds.length > 0) {
    const { data: assignments } = await db
      .from('sf_job_techs_cache')
      .select('sf_job_id, sf_tech_id')
      .in('sf_job_id', sfJobIds)

    for (const a of assignments ?? []) {
      const jobId = a.sf_job_id as string
      const techId = a.sf_tech_id as string
      if (!sfByTech[techId]) sfByTech[techId] = { jobs: 0, revenue: 0 }
      sfByTech[techId].jobs++
      sfByTech[techId].revenue += invoiceRevenueByJobId.get(jobId) ?? 0
    }
  }

  // 5. Fetch piecework pay for the week from the jobs table
  const { data: pieceworkJobs } = await db
    .from('jobs')
    .select('tech_id, total_pay')
    .eq('week_start_date', weekStart)

  const pieceworkByTechUuid: Record<string, number> = {}
  for (const j of pieceworkJobs ?? []) {
    const techId = j.tech_id as string
    pieceworkByTechUuid[techId] = (pieceworkByTechUuid[techId] ?? 0) + ((j.total_pay as number) ?? 0)
  }

  // 6. Merge by sf_technician_id
  // Collect all SF tech IDs that appear in the scoreboard
  const allSfTechIds = new Set(Object.keys(sfByTech))

  const rows = Array.from(allSfTechIds).map(sfTechId => {
    const sf = sfByTech[sfTechId] ?? { jobs: 0, revenue: 0 }
    const profile = sfIdToProfile.get(sfTechId)

    let pieceworkPay: number | null = null
    if (profile) {
      const pay = pieceworkByTechUuid[profile.id]
      if (pay !== undefined) pieceworkPay = pay
    }

    const profit = pieceworkPay !== null ? sf.revenue - pieceworkPay : null
    const marginPct = profit !== null && sf.revenue > 0
      ? (profit / sf.revenue) * 100
      : null

    return {
      techId: sfTechId,
      techName: profile?.full_name ?? null,
      sfJobs: sf.jobs,
      sfRevenue: sf.revenue,
      avgTicket: sf.jobs > 0 ? sf.revenue / sf.jobs : 0,
      pieceworkPay,
      profit,
      marginPct,
    }
  }).sort((a, b) => b.sfRevenue - a.sfRevenue)

  return NextResponse.json({ weekStart, weekEnd, rows })
}
