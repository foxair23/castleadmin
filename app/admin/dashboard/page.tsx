import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import DashboardClient from './DashboardClient'
import { getTechScoreboard } from '@/lib/analytics/metrics'

// Business acquisition date. Open-work and pipeline measures are scoped to
// activity since this date so pre-acquisition Service Fusion history doesn't
// inflate current counts.
const ACQUISITION_DATE = '2026-04-24'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') redirect('/admin')

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Check if any data exists
  const { count } = await db.from('sf_jobs_cache').select('id', { count: 'exact', head: true })
  const hasData = (count ?? 0) > 0

  // Row-set queries paginate via fetchAllRows (stable order('id')) so 90-day
  // windows and unbounded lists aren't truncated at PostgREST's 1000-row cap.
  // The JS aggregation below (daily/weekly grouping, rolling averages) is
  // order-independent, so ordering by id only serves stable pagination.
  const todayStr = today()
  const [
    { count: openJobsCount },
    openEstimates,
    arData,
    capacityJobs,
    schedHistory,
    jobVolumeRows,
    { data: lastSyncLog },
    closedJobsRevenue,
  ] = await Promise.all([
    // Only count open jobs created since the acquisition — historical
    // pre-acquisition jobs otherwise inflate this number into the thousands.
    db.from('sf_jobs_cache').select('id', { count: 'exact', head: true }).eq('is_closed', false).gte('created_at_sf', ACQUISITION_DATE),
    fetchAllRows<{ id: string; total: number | null; status: string | null; created_at_sf: string | null }>((f, t) =>
      db.from('sf_estimates_cache').select('id, total, status, created_at_sf').not('status', 'in', '("accepted","declined","Accepted","Declined")').gte('created_at_sf', ACQUISITION_DATE).order('id', { ascending: true }).range(f, t)),
    fetchAllRows<{ balance_due: number | null }>((f, t) =>
      db.from('sf_invoices_cache').select('balance_due').gt('balance_due', 0).order('id', { ascending: true }).range(f, t)),
    fetchAllRows<{ completed_at: string | null; original_scheduled_at: string | null }>((f, t) =>
      db.from('sf_jobs_cache').select('completed_at, original_scheduled_at, id').eq('is_closed', true).gte('completed_at', daysAgo(90)).not('completed_at', 'is', null).not('original_scheduled_at', 'is', null).order('id', { ascending: true }).range(f, t)),
    // Schedule-change history over ~6 months so the monthly reschedule trend and
    // detail table have enough data.
    fetchAllRows<{ sf_job_id: string | null; change_type: string | null; reschedule_reason: string | null; observed_at: string | null; scheduled_at: string | null; previous_scheduled_at: string | null; job_status_at_change: string | null }>((f, t) =>
      db.from('sf_job_schedule_history').select('sf_job_id, change_type, reschedule_reason, observed_at, scheduled_at, previous_scheduled_at, job_status_at_change, id').gte('observed_at', daysAgo(180)).order('id', { ascending: true }).range(f, t)),
    // Job volume by week for 2025 + 2026 — count of completed jobs, bucketed by
    // week of closed_at (same completion basis as Monthly Revenue).
    fetchAllRows<{ closed_at: string | null }>((f, t) =>
      db.from('sf_jobs')
        .select('closed_at')
        .eq('is_deleted', false)
        .not('status', 'in', '("Cancelled","Void","Voided")')
        .gte('closed_at', '2025-01-01')
        .lt('closed_at', '2027-01-01')
        .order('id', { ascending: true })
        .range(f, t)),
    db.from('sf_sync_runs').select('sync_type:run_type, status, completed_at, records_synced:records_upserted').eq('status', 'completed').order('completed_at', { ascending: false }).limit(1),
    // Revenue Today / This Week / 28-day avg — same logic as monthly_job_revenue RPC:
    // sum(sf_jobs.total) bucketed by closed_at, excluding deleted + cancelled/void jobs.
    fetchAllRows<{ closed_at: string | null; total: number | null }>((f, t) =>
      db.from('sf_jobs')
        .select('closed_at, total')
        .eq('is_deleted', false)
        .not('status', 'in', '("Cancelled","Void","Voided")')
        .not('closed_at', 'is', null)
        .gte('closed_at', daysAgo(90))
        .order('id', { ascending: true })
        .range(f, t)),
  ])

  // Compute snapshot — all three revenue metrics use the same source as the
  // monthly_job_revenue RPC: sf_jobs.total bucketed by closed_at, excluding
  // deleted + cancelled/void jobs.
  const revenueToday = closedJobsRevenue
    .filter(r => r.closed_at?.slice(0, 10) === todayStr)
    .reduce((s, r) => s + (r.total ?? 0), 0)

  const revenueWeek = closedJobsRevenue
    .filter(r => (r.closed_at ?? '') >= daysAgo(7))
    .reduce((s, r) => s + (r.total ?? 0), 0)

  const dailyRevTotals: Record<string, number> = {}
  for (const r of closedJobsRevenue.filter(r => (r.closed_at ?? '') >= daysAgo(28))) {
    const d = r.closed_at?.slice(0, 10) ?? ''
    if (d) dailyRevTotals[d] = (dailyRevTotals[d] ?? 0) + (r.total ?? 0)
  }
  const dailyValues = Object.values(dailyRevTotals)
  const avgDailyRevenue = dailyValues.length > 0 ? dailyValues.reduce((a, b) => a + b, 0) / dailyValues.length : 0

  const outstandingAR = (arData ?? []).reduce((s: number, r: { balance_due?: number | null }) => s + (r.balance_due ?? 0), 0)
  const openEstimatesValue = (openEstimates ?? []).reduce((s: number, r: { total?: number | null }) => s + (r.total ?? 0), 0)

  // Weekly job volume — completed-job counts per week-of-year, split by year so
  // 2025 and 2026 can be compared on the same axis (weeks 1–52).
  const volByYearWeek: Record<number, Record<number, number>> = { 2025: {}, 2026: {} }
  for (const r of jobVolumeRows) {
    const ymd = r.closed_at?.slice(0, 10)
    if (!ymd) continue
    const year = Number(ymd.slice(0, 4))
    if (year !== 2025 && year !== 2026) continue
    const wk = weekOfYear(ymd)
    volByYearWeek[year][wk] = (volByYearWeek[year][wk] ?? 0) + 1
  }
  const weeklyJobVolume = Array.from({ length: 52 }, (_, i) => {
    const week = i + 1
    return { week, jobs2025: volByYearWeek[2025][week] ?? 0, jobs2026: volByYearWeek[2026][week] ?? 0 }
  })

  // Capacity
  type CapWeek = { sameDayCount: number; total: number; leadTimeDays: number[] }
  const capByWeek: Record<string, CapWeek> = {}
  for (const row of (capacityJobs ?? []) as { completed_at?: string | null; original_scheduled_at?: string | null }[]) {
    if (!row.completed_at || !row.original_scheduled_at) continue
    const comp = new Date(row.completed_at)
    const sched = new Date(row.original_scheduled_at)
    const w = weekStartStr(comp)
    if (!capByWeek[w]) capByWeek[w] = { sameDayCount: 0, total: 0, leadTimeDays: [] }
    const diffH = (comp.getTime() - sched.getTime()) / 3_600_000
    if (diffH <= 24) capByWeek[w].sameDayCount++
    capByWeek[w].total++
    capByWeek[w].leadTimeDays.push(Math.max(0, diffH / 24))
  }
  const capacityWeeks = Object.entries(capByWeek).sort(([a], [b]) => a.localeCompare(b)).map(([week, v]) => ({
    week,
    sameDayRate: v.total > 0 ? v.sameDayCount / v.total : null,
    medianLeadDays: medianOf(v.leadTimeDays),
    totalJobs: v.total,
  }))

  // Reschedule trend — bucketed by MONTH now (was weekly).
  const schedHistoryTyped = (schedHistory ?? []) as { sf_job_id?: string | null; change_type?: string | null; reschedule_reason?: string | null; observed_at?: string | null; scheduled_at?: string | null; previous_scheduled_at?: string | null; job_status_at_change?: string | null }[]
  const firstInitial = schedHistoryTyped.find(r => r.change_type === 'initial')
  const trackingSince = firstInitial?.observed_at?.slice(0, 10) ?? null
  type RMonth = { rescheduled: number; partsRescheduled: number; totalInitial: number }
  const reschedByMonth: Record<string, RMonth> = {}
  for (const row of schedHistoryTyped) {
    if (!row.observed_at) continue
    const m = row.observed_at.slice(0, 7) // YYYY-MM
    if (!reschedByMonth[m]) reschedByMonth[m] = { rescheduled: 0, partsRescheduled: 0, totalInitial: 0 }
    if (row.change_type === 'initial') reschedByMonth[m].totalInitial++
    if (row.change_type === 'rescheduled') {
      reschedByMonth[m].rescheduled++
      if (row.reschedule_reason === 'parts_or_incomplete') reschedByMonth[m].partsRescheduled++
    }
  }
  const rescheduleTrend = {
    trackingSince,
    months: Object.entries(reschedByMonth).sort(([a], [b]) => a.localeCompare(b)).map(([month, v]) => ({
      month,
      rescheduleRate: v.totalInitial > 0 ? v.rescheduled / v.totalInitial : null,
      partsRescheduleRate: v.totalInitial > 0 ? v.partsRescheduled / v.totalInitial : null,
    })),
  }

  // Reschedule detail — one row per reschedule event (most recent first),
  // enriched with the job's customer + number so it can be looked into.
  const reschedEvents = schedHistoryTyped
    .filter(r => r.change_type === 'rescheduled' && r.observed_at)
    .sort((a, b) => (b.observed_at ?? '').localeCompare(a.observed_at ?? ''))
    .slice(0, 200)
  const reschedJobIds = [...new Set(reschedEvents.map(r => r.sf_job_id).filter((id): id is string => !!id))]
  const reschedJobInfo = new Map<string, { number: string | null; customer_name: string | null }>()
  if (reschedJobIds.length > 0) {
    const CHUNK = 500
    for (let i = 0; i < reschedJobIds.length; i += CHUNK) {
      const { data } = await db.from('sf_jobs').select('id, number, customer_name').in('id', reschedJobIds.slice(i, i + CHUNK))
      for (const j of (data ?? []) as { id: string; number: string | null; customer_name: string | null }[]) {
        reschedJobInfo.set(j.id, { number: j.number, customer_name: j.customer_name })
      }
    }
  }
  const rescheduleDetail = reschedEvents.map(r => {
    const info = r.sf_job_id ? reschedJobInfo.get(r.sf_job_id) : undefined
    return {
      jobId: r.sf_job_id ?? '',
      number: info?.number ?? null,
      customer: info?.customer_name ?? null,
      from: r.previous_scheduled_at ?? null,
      to: r.scheduled_at ?? null,
      reason: r.reschedule_reason ?? null,
      status: r.job_status_at_change ?? null,
      observedAt: r.observed_at ?? null,
    }
  })

  // Tech scoreboard
  const currentWeekStart = weekStartStr(new Date())
  const techScoreboard = await getTechScoreboard(db, currentWeekStart)

  // Monthly revenue + tech attribution (piecework). Company revenue is computed
  // server-side by the monthly_job_revenue() RPC — sum(sf_jobs.total) bucketed by
  // month of closed_at (revenue recognized on completion). Using an RPC sidesteps
  // PostgREST's 1000-row response cap, which silently truncated the prior approach.
  const [
    { data: monthlyRevRows },
    pwJobsForChart,
    { data: techProfilesForChart },
  ] = await Promise.all([
    db.rpc('monthly_job_revenue'),
    fetchAllRows<{ tech_id: string | null; sf_job_id: string | null; week_start_date: string | null }>((f, t) =>
      db.from('jobs').select('tech_id, sf_job_id, week_start_date').gte('week_start_date', '2026-04-24').not('sf_job_id', 'is', null).order('id', { ascending: true }).range(f, t)),
    db.from('profiles')
      .select('id, full_name')
      .eq('role', 'technician')
      .eq('is_active', true),
  ])

  // Company monthly revenue: RPC returns one { ym: 'YYYY-MM', revenue } row per month.
  const jobsByYearMonth: Record<string, number> = {}
  for (const r of (monthlyRevRows ?? []) as { ym: string | null; revenue: number | string | null }[]) {
    if (r.ym) jobsByYearMonth[r.ym] = Number(r.revenue ?? 0)
  }
  const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const monthlyRevenue = MONTHS_SHORT.map((label, i) => {
    const m = String(i + 1).padStart(2, '0')
    return { month: label, revenue2025: jobsByYearMonth[`2025-${m}`] ?? 0, revenue2026: jobsByYearMonth[`2026-${m}`] ?? 0 }
  })

  // Tech monthly revenue — deduplicate sf_job_ids per tech per month
  const chartSfJobIds = [...new Set(
    (pwJobsForChart ?? []).map((j: { sf_job_id?: string | null }) => j.sf_job_id).filter((id): id is string => !!id)
  )]
  // Chunk the .in() to avoid URL length limits when there are many SF job IDs.
  const chartSfRevMap = new Map<string, number>()
  if (chartSfJobIds.length > 0) {
    const CHUNK = 500
    for (let i = 0; i < chartSfJobIds.length; i += CHUNK) {
      const { data: chunk } = await db.from('sf_jobs_cache').select('id, total_amount').in('id', chartSfJobIds.slice(i, i + CHUNK))
      for (const j of (chunk ?? []) as { id: string; total_amount: number | null }[]) {
        chartSfRevMap.set(j.id, j.total_amount ?? 0)
      }
    }
  }

  const techNameMap = new Map(
    (techProfilesForChart ?? []).map((p: { id: string; full_name?: string | null }) => [p.id, p.full_name ?? `Tech ${p.id.slice(0, 8)}`])
  )
  const techMonthSfIds: Record<string, Record<string, Set<string>>> = {}
  for (const job of (pwJobsForChart ?? []) as { tech_id?: string | null; sf_job_id?: string | null; week_start_date?: string | null }[]) {
    const { tech_id, sf_job_id, week_start_date } = job
    if (!tech_id || !sf_job_id || !week_start_date) continue
    const ym = week_start_date.slice(0, 7)
    if (!techMonthSfIds[tech_id]) techMonthSfIds[tech_id] = {}
    if (!techMonthSfIds[tech_id][ym]) techMonthSfIds[tech_id][ym] = new Set()
    techMonthSfIds[tech_id][ym].add(sf_job_id)
  }
  const techMonthlyRevenue = Object.entries(techMonthSfIds)
    .map(([techId, byMonth]) => ({
      techId,
      techName: techNameMap.get(techId) ?? `Tech ${techId.slice(0, 8)}`,
      data: Object.entries(byMonth)
        .map(([yearMonth, sfIds]) => ({
          yearMonth,
          revenue: [...sfIds].reduce((s, id) => s + (chartSfRevMap.get(id) ?? 0), 0),
        }))
        .sort((a, b) => a.yearMonth.localeCompare(b.yearMonth)),
    }))
    .filter(t => t.data.length > 0)
    .sort((a, b) => {
      const totalA = a.data.reduce((s, d) => s + d.revenue, 0)
      const totalB = b.data.reduce((s, d) => s + d.revenue, 0)
      return totalB - totalA
    })

  return (
    <DashboardClient
      hasData={hasData}
      snapshotMetrics={{
        revenueToday,
        revenueTodayDelta: avgDailyRevenue > 0 ? ((revenueToday - avgDailyRevenue) / avgDailyRevenue) * 100 : 0,
        revenueWeek,
        avgDailyRevenue,
        openJobsCount: openJobsCount ?? 0,
        openEstimatesCount: openEstimates?.length ?? 0,
        openEstimatesValue,
        outstandingAR,
      }}
      capacityWeeks={capacityWeeks}
      rescheduleTrend={rescheduleTrend}
      rescheduleDetail={rescheduleDetail}
      weeklyJobVolume={weeklyJobVolume}
      techScoreboard={techScoreboard}
      lastSync={(lastSyncLog?.[0] as { sync_type: string; completed_at: string; records_synced: number } | undefined) ?? null}
      monthlyRevenue={monthlyRevenue}
      techMonthlyRevenue={techMonthlyRevenue}
    />
  )
}

async function fetchAllRows<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null }>
): Promise<T[]> {
  const PAGE = 1000
  const out: T[] = []
  let from = 0
  for (;;) {
    const { data } = await build(from, from + PAGE - 1)
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < PAGE) break
    from += PAGE
  }
  return out
}

// Dates are computed in America/Los_Angeles because Service Fusion stores job
// timestamps as Pacific wall-clock (no offset), so closed_at's date portion is
// the PT calendar date. Using UTC here made "today" roll over ~4–5pm PT, which
// is why Revenue Today read $0 whenever the dashboard was viewed in the
// afternoon/evening.
function today(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}
function daysAgo(n: number): string {
  const [y, m, d] = today().split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() - n)
  return dt.toISOString().slice(0, 10)
}
// Week-of-year (1–52) by day-of-year, so 2025 and 2026 line up on the same
// axis. Week 53 is folded into 52. Parsed from the YYYY-MM-DD parts to avoid
// timezone shifts.
function weekOfYear(ymd: string): number {
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number)
  const start = Date.UTC(y, 0, 1)
  const day = Date.UTC(y, m - 1, d)
  const doy = Math.floor((day - start) / 86_400_000) + 1
  return Math.min(52, Math.floor((doy - 1) / 7) + 1)
}
function weekStartStr(d: Date): string {
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  const mon = new Date(d); mon.setDate(d.getDate() + diff)
  return mon.toISOString().slice(0, 10)
}
function medianOf(arr: number[]): number | null {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m]
}
