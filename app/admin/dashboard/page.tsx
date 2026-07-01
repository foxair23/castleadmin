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
    jobVolumeRows,
    { data: lastSyncLog },
    closedJobsRevenue,
    schedulerLeads,
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
    // Online scheduling leads — for the "Jobs Synced to SF vs Partial Leads by
    // month" section. Bucketed by created_at (month the lead came in).
    fetchAllRows<{ created_at: string | null; synced_at: string | null; is_partial: boolean | null }>((f, t) =>
      db.from('scheduler_leads')
        .select('created_at, synced_at, is_partial, id')
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

  // Jobs per month — completed-job count for each month, split by year so 2025
  // and 2026 can be compared on the same axis.
  const cntByYearMonth: Record<number, number[]> = { 2025: Array(12).fill(0), 2026: Array(12).fill(0) }
  for (const r of jobVolumeRows) {
    const ymd = r.closed_at?.slice(0, 10)
    if (!ymd) continue
    const year = Number(ymd.slice(0, 4))
    if (year !== 2025 && year !== 2026) continue
    const mo = Number(ymd.slice(5, 7)) - 1
    if (mo >= 0 && mo < 12) cntByYearMonth[year][mo]++
  }
  const MONTH_LABELS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const jobsPerMonth = MONTH_LABELS_SHORT.map((label, i) => ({
    month: label,
    jobs2025: cntByYearMonth[2025][i],
    jobs2026: cntByYearMonth[2026][i],
  }))

  // Online scheduling volume by month — leads synced to SF vs partial leads,
  // bucketed by the month the lead came in (created_at). Synced and partial are
  // disjoint (a synced lead has synced_at; a partial lead is incomplete).
  const schedByMonth: Record<string, { synced: number; partial: number }> = {}
  for (const l of schedulerLeads) {
    const ym = l.created_at?.slice(0, 7)
    if (!ym) continue
    if (!schedByMonth[ym]) schedByMonth[ym] = { synced: 0, partial: 0 }
    if (l.synced_at) schedByMonth[ym].synced++
    else if (l.is_partial) schedByMonth[ym].partial++
  }
  const schedulingByMonth = Object.entries(schedByMonth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ym, v]) => ({ ym, label: monthLabelShort(ym), synced: v.synced, partial: v.partial }))

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
      jobsPerMonth={jobsPerMonth}
      schedulingByMonth={schedulingByMonth}
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
function weekStartStr(d: Date): string {
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  const mon = new Date(d); mon.setDate(d.getDate() + diff)
  return mon.toISOString().slice(0, 10)
}
function monthLabelShort(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${names[(m ?? 1) - 1]} ${String(y).slice(2)}`
}
function medianOf(arr: number[]): number | null {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m]
}
