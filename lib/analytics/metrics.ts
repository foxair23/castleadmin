import { SupabaseClient } from '@supabase/supabase-js'

// Helper: date string YYYY-MM-DD for N days ago
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

// ── Snapshot metrics ──────────────────────────────────────────────────────

export async function getSnapshotMetrics(db: SupabaseClient) {
  const todayStr = today()
  const twentyEightDaysAgo = daysAgo(28)
  const sevenDaysAgo = daysAgo(7)

  const [
    { data: todayInvoices },
    { data: weekInvoices },
    { data: trailingInvoices },
    { data: openJobs },
    { data: openEstimates },
    { data: arData },
  ] = await Promise.all([
    // Revenue today
    db.from('sf_invoices_cache').select('total').gte('issued_at', todayStr).lt('issued_at', daysAgo(-1)),
    // Revenue this week (Mon–today)
    db.from('sf_invoices_cache').select('total').gte('issued_at', sevenDaysAgo),
    // Trailing 28d invoices (for avg)
    db.from('sf_invoices_cache').select('total, issued_at').gte('issued_at', twentyEightDaysAgo),
    // Open jobs (not closed, not cancelled)
    db.from('sf_jobs_cache').select('id', { count: 'exact', head: true }).eq('is_closed', false),
    // Open estimates
    db.from('sf_estimates_cache').select('id, total').not('status', 'in', '("accepted","declined","Accepted","Declined")'),
    // Outstanding A/R
    db.from('sf_invoices_cache').select('balance_due').gt('balance_due', 0),
  ])

  const revenueToday = (todayInvoices ?? []).reduce((s, r) => s + (r.total ?? 0), 0)
  const revenueWeek = (weekInvoices ?? []).reduce((s, r) => s + (r.total ?? 0), 0)

  // 28d daily average
  const dailyTotals: Record<string, number> = {}
  for (const row of (trailingInvoices ?? [])) {
    const d = row.issued_at?.slice(0, 10) ?? ''
    if (d) dailyTotals[d] = (dailyTotals[d] ?? 0) + (row.total ?? 0)
  }
  const dailyValues = Object.values(dailyTotals)
  const avgDailyRevenue = dailyValues.length > 0
    ? dailyValues.reduce((a, b) => a + b, 0) / dailyValues.length
    : 0

  const openEstimatesCount = openEstimates?.length ?? 0
  const openEstimatesValue = (openEstimates ?? []).reduce((s, r) => s + (r.total ?? 0), 0)
  const outstandingAR = (arData ?? []).reduce((s, r) => s + (r.balance_due ?? 0), 0)

  return {
    revenueToday,
    revenueTodayDelta: avgDailyRevenue > 0 ? ((revenueToday - avgDailyRevenue) / avgDailyRevenue) * 100 : 0,
    revenueWeek,
    avgDailyRevenue,
    openJobsCount: openJobs ?? 0,
    openEstimatesCount,
    openEstimatesValue,
    outstandingAR,
  }
}

// ── Revenue trend (last N days) ───────────────────────────────────────────

export async function getRevenueTrend(db: SupabaseClient, days = 90) {
  const from = daysAgo(days)
  const { data } = await db
    .from('sf_invoices_cache')
    .select('issued_at, total')
    .gte('issued_at', from)
    .order('issued_at', { ascending: true })

  // Group by day
  const byDay: Record<string, number> = {}
  for (const row of (data ?? [])) {
    const d = row.issued_at?.slice(0, 10) ?? ''
    if (d) byDay[d] = (byDay[d] ?? 0) + (row.total ?? 0)
  }

  // Fill in all days
  const result: { date: string; revenue: number; rolling28: number | null }[] = []
  for (let i = days; i >= 0; i--) {
    const d = daysAgo(i)
    result.push({ date: d, revenue: byDay[d] ?? 0, rolling28: null })
  }

  // Compute 28-day rolling average
  for (let i = 27; i < result.length; i++) {
    const window = result.slice(i - 27, i + 1)
    result[i].rolling28 = window.reduce((s, r) => s + r.revenue, 0) / 28
  }

  return result
}

// ── Jobs completed trend ──────────────────────────────────────────────────

export async function getJobsTrend(db: SupabaseClient, days = 90) {
  const from = daysAgo(days)
  const { data } = await db
    .from('sf_jobs_cache')
    .select('completed_at')
    .eq('is_closed', true)
    .gte('completed_at', from)
    .not('completed_at', 'is', null)

  const byDay: Record<string, number> = {}
  for (const row of (data ?? [])) {
    const d = row.completed_at?.slice(0, 10) ?? ''
    if (d) byDay[d] = (byDay[d] ?? 0) + 1
  }

  const result: { date: string; jobs: number; rolling28: number | null }[] = []
  for (let i = days; i >= 0; i--) {
    const d = daysAgo(i)
    result.push({ date: d, jobs: byDay[d] ?? 0, rolling28: null })
  }
  for (let i = 27; i < result.length; i++) {
    const window = result.slice(i - 27, i + 1)
    result[i].rolling28 = window.reduce((s, r) => s + r.jobs, 0) / 28
  }
  return result
}

// ── Capacity: same-day service rate & lead time ───────────────────────────

export async function getCapacityMetrics(db: SupabaseClient, days = 90) {
  const from = daysAgo(days)
  const { data } = await db
    .from('sf_jobs_cache')
    .select('completed_at, original_scheduled_at, schedule_history_truncated')
    .eq('is_closed', true)
    .gte('completed_at', from)
    .not('completed_at', 'is', null)
    .not('original_scheduled_at', 'is', null)

  // Group by week
  const byWeek: Record<string, { sameDayCount: number; total: number; leadTimeDays: number[] }> = {}

  for (const row of (data ?? [])) {
    const completedAt = new Date(row.completed_at)
    const scheduledAt = new Date(row.original_scheduled_at)
    const weekStart = getWeekStart(completedAt)
    if (!byWeek[weekStart]) byWeek[weekStart] = { sameDayCount: 0, total: 0, leadTimeDays: [] }

    const diffHours = (completedAt.getTime() - scheduledAt.getTime()) / 3_600_000
    const diffDays = diffHours / 24
    if (diffHours <= 24) byWeek[weekStart].sameDayCount++
    byWeek[weekStart].total++
    byWeek[weekStart].leadTimeDays.push(Math.max(0, diffDays))
  }

  return Object.entries(byWeek)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, v]) => ({
      week,
      sameDayRate: v.total > 0 ? v.sameDayCount / v.total : null,
      medianLeadDays: median(v.leadTimeDays),
      totalJobs: v.total,
    }))
}

function median(arr: number[]): number | null {
  if (arr.length === 0) return null
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function getWeekStart(d: Date): string {
  const day = d.getDay()
  const diff = (day === 0 ? -6 : 1 - day) // Monday
  const monday = new Date(d)
  monday.setDate(d.getDate() + diff)
  return monday.toISOString().slice(0, 10)
}

// ── Reschedule rate by week ───────────────────────────────────────────────

export async function getRescheduleTrend(db: SupabaseClient, days = 90) {
  const from = daysAgo(days)

  // Get first observed_at per job (to find the tracking start date)
  const { data: firstSync } = await db
    .from('sf_job_schedule_history')
    .select('observed_at')
    .eq('change_type', 'initial')
    .order('observed_at', { ascending: true })
    .limit(1)

  const trackingSince = firstSync?.[0]?.observed_at?.slice(0, 10) ?? null

  const { data } = await db
    .from('sf_job_schedule_history')
    .select('sf_job_id, change_type, reschedule_reason, reschedule_reason_source, observed_at')
    .gte('observed_at', from)
    .order('observed_at', { ascending: true })

  // Group rescheduled events by week
  const byWeek: Record<string, { rescheduled: number; partsRescheduled: number; totalInitial: number }> = {}
  for (const row of (data ?? [])) {
    const week = getWeekStart(new Date(row.observed_at))
    if (!byWeek[week]) byWeek[week] = { rescheduled: 0, partsRescheduled: 0, totalInitial: 0 }
    if (row.change_type === 'initial') byWeek[week].totalInitial++
    if (row.change_type === 'rescheduled') {
      byWeek[week].rescheduled++
      if (row.reschedule_reason === 'parts_or_incomplete') byWeek[week].partsRescheduled++
    }
  }

  return {
    trackingSince,
    weeks: Object.entries(byWeek).sort(([a], [b]) => a.localeCompare(b)).map(([week, v]) => ({
      week,
      rescheduleRate: v.totalInitial > 0 ? v.rescheduled / v.totalInitial : null,
      partsRescheduleRate: v.totalInitial > 0 ? v.partsRescheduled / v.totalInitial : null,
      totalRescheduled: v.rescheduled,
      totalPartsRescheduled: v.partsRescheduled,
    })),
  }
}

// ── Tech scoreboard ───────────────────────────────────────────────────────

export async function getTechScoreboard(db: SupabaseClient, weekStart: string) {
  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekEnd.getDate() + 6)
  const weekEndStr = weekEnd.toISOString().slice(0, 10)

  const twelveWeeksAgo = new Date(weekStart)
  twelveWeeksAgo.setDate(twelveWeeksAgo.getDate() - 84)
  const baselineFrom = twelveWeeksAgo.toISOString().slice(0, 10)

  // Load name mapping from profiles (sf_technician_id → full_name)
  const { data: profiles } = await db
    .from('profiles')
    .select('sf_technician_id, full_name')
    .not('sf_technician_id', 'is', null)
  const nameMap = new Map<string, string>()
  for (const p of profiles ?? []) {
    if (p.sf_technician_id) nameMap.set(String(p.sf_technician_id), p.full_name)
  }

  // Fetch closed jobs in the relevant window
  const { data: jobs } = await db
    .from('sf_jobs_cache')
    .select('id, total_amount, completed_at')
    .eq('is_closed', true)
    .gte('completed_at', baselineFrom)
    .lte('completed_at', weekEndStr)
    .not('completed_at', 'is', null)

  if (!jobs || jobs.length === 0) return []

  const jobIds = jobs.map(j => j.id as string)
  const jobMap = new Map(jobs.map(j => [j.id as string, j]))

  // Fetch tech assignments for those jobs
  const { data: assignments } = await db
    .from('sf_job_techs_cache')
    .select('sf_job_id, sf_tech_id')
    .in('sf_job_id', jobIds)

  // Aggregate
  const weekByTech: Record<string, { jobs: number; revenue: number }> = {}
  const baselineByTech: Record<string, { jobs: number; revenue: number }> = {}

  for (const a of assignments ?? []) {
    const jobId = a.sf_job_id as string
    const techId = a.sf_tech_id as string
    const job = jobMap.get(jobId)
    if (!job) continue

    const completedDate = (job.completed_at as string).slice(0, 10)
    const revenue = (job.total_amount as number) ?? 0

    if (completedDate >= weekStart && completedDate <= weekEndStr) {
      if (!weekByTech[techId]) weekByTech[techId] = { jobs: 0, revenue: 0 }
      weekByTech[techId].jobs++
      weekByTech[techId].revenue += revenue
    } else {
      if (!baselineByTech[techId]) baselineByTech[techId] = { jobs: 0, revenue: 0 }
      baselineByTech[techId].jobs++
      baselineByTech[techId].revenue += revenue
    }
  }

  const allTechIds = new Set([...Object.keys(weekByTech), ...Object.keys(baselineByTech)])

  return Array.from(allTechIds).map(techId => {
    const week = weekByTech[techId] ?? { jobs: 0, revenue: 0 }
    const baseline = baselineByTech[techId] ?? { jobs: 0, revenue: 0 }
    const baselineWeeklyRevenue = baseline.revenue / 12
    const baselineWeeklyJobs = baseline.jobs / 12
    const revenueDeltaPct = baselineWeeklyRevenue > 0
      ? ((week.revenue - baselineWeeklyRevenue) / baselineWeeklyRevenue) * 100
      : null

    return {
      techId,
      techName: nameMap.get(techId) ?? null,
      jobsThisWeek: week.jobs,
      revenueThisWeek: week.revenue,
      avgTicketThisWeek: week.jobs > 0 ? week.revenue / week.jobs : 0,
      baselineWeeklyRevenue,
      baselineWeeklyJobs,
      revenueDeltaPct,
    }
  }).sort((a, b) => b.revenueThisWeek - a.revenueThisWeek)
}

// ── Pipeline (estimates) ──────────────────────────────────────────────────

export async function getPipelineMetrics(db: SupabaseClient) {
  const { data: open } = await db
    .from('sf_estimates_cache')
    .select('id, total, created_at_sf, status')
    .not('status', 'in', '("accepted","declined","Accepted","Declined","Closed")')

  const now = Date.now()
  const buckets = { fresh: 0, aging: 0, old: 0, freshValue: 0, agingValue: 0, oldValue: 0 }

  for (const est of (open ?? [])) {
    const ageDays = est.created_at_sf
      ? (now - new Date(est.created_at_sf).getTime()) / 86_400_000
      : 999
    const val = est.total ?? 0
    if (ageDays <= 7) { buckets.fresh++; buckets.freshValue += val }
    else if (ageDays <= 30) { buckets.aging++; buckets.agingValue += val }
    else { buckets.old++; buckets.oldValue += val }
  }

  return {
    totalOpen: open?.length ?? 0,
    totalValue: (open ?? []).reduce((s, r) => s + (r.total ?? 0), 0),
    buckets,
  }
}

// ── Scheduled backlog (next 7 days) ──────────────────────────────────────

export async function getScheduledBacklog(db: SupabaseClient) {
  const fromStr = today()
  const toStr = daysAgo(-7)

  const { count } = await db
    .from('sf_jobs_cache')
    .select('id', { count: 'exact' })
    .eq('is_closed', false)
    .gte('scheduled_at', fromStr)
    .lte('scheduled_at', toStr)

  return { count: count ?? 0 }
}

// ── Annotations ───────────────────────────────────────────────────────────

export async function getAnnotations(db: SupabaseClient) {
  const { data } = await db
    .from('dashboard_annotations')
    .select('*')
    .order('occurred_on', { ascending: true })
  return data ?? []
}

// ── Last sync time ────────────────────────────────────────────────────────

export async function getLastSyncInfo(db: SupabaseClient) {
  const { data } = await db
    .from('analytics_sync_log')
    .select('sync_type, status, completed_at, records_synced')
    .eq('status', 'complete')
    .order('completed_at', { ascending: false })
    .limit(1)

  return data?.[0] ?? null
}
