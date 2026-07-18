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
    // week of work_completed_at (when the work was done — same basis as Monthly
    // Revenue; closed_at is only stamped at invoicing, see migration 054).
    fetchAllRows<{ work_completed_at: string | null }>((f, t) =>
      db.from('sf_jobs')
        .select('work_completed_at')
        .eq('is_deleted', false)
        .not('status', 'in', '("Cancelled","Void","Voided")')
        .gte('work_completed_at', '2025-01-01')
        .lt('work_completed_at', '2027-01-01')
        .order('id', { ascending: true })
        .range(f, t)),
    db.from('sf_sync_runs').select('sync_type:run_type, status, completed_at, records_synced:records_upserted').eq('status', 'completed').order('completed_at', { ascending: false }).limit(1),
    // Revenue Today / This Week / 28-day avg — same basis as monthly_job_revenue:
    // sum(sf_jobs.total) bucketed by work_completed_at (work date, not invoice
    // date), excluding deleted + cancelled/void jobs.
    fetchAllRows<{ work_completed_at: string | null; total: number | null }>((f, t) =>
      db.from('sf_jobs')
        .select('work_completed_at, total')
        .eq('is_deleted', false)
        .not('status', 'in', '("Cancelled","Void","Voided")')
        .not('work_completed_at', 'is', null)
        .gte('work_completed_at', daysAgo(90))
        .order('id', { ascending: true })
        .range(f, t)),
    // Online scheduling leads that have been acknowledged ("Done"). These make
    // up both the by-month bar chart and the per-submission table below it.
    fetchAllRows<{
      id: string; created_at: string | null; synced_at: string | null; is_partial: boolean | null
      service_type: string | null; service_category: string | null; appointment_date: string | null
      customer_first_name: string | null; customer_last_name: string | null
      service_fusion_job_id: string | null; acknowledged_at: string | null; acknowledged_by: string | null
    }>((f, t) =>
      db.from('scheduler_leads')
        .select('id, created_at, synced_at, is_partial, service_type, service_category, appointment_date, customer_first_name, customer_last_name, service_fusion_job_id, acknowledged_at, acknowledged_by')
        .not('acknowledged_at', 'is', null)
        .order('id', { ascending: true })
        .range(f, t)),
  ])

  // Compute snapshot — all three revenue metrics use the same source as the
  // monthly_job_revenue RPC: sf_jobs.total bucketed by work_completed_at (the
  // work date, not the invoice date), excluding deleted + cancelled/void jobs.
  const revenueToday = closedJobsRevenue
    .filter(r => r.work_completed_at?.slice(0, 10) === todayStr)
    .reduce((s, r) => s + (r.total ?? 0), 0)

  const revenueWeek = closedJobsRevenue
    .filter(r => (r.work_completed_at ?? '') >= daysAgo(7))
    .reduce((s, r) => s + (r.total ?? 0), 0)

  const dailyRevTotals: Record<string, number> = {}
  for (const r of closedJobsRevenue.filter(r => (r.work_completed_at ?? '') >= daysAgo(28))) {
    const d = r.work_completed_at?.slice(0, 10) ?? ''
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
    const ymd = r.work_completed_at?.slice(0, 10)
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

  // Online scheduling — acknowledged ("Done") submissions only. The bar chart
  // aggregates these by month (synced to SF vs partial), and the table lists the
  // individual submissions that make up those bars. A lead counts as 'synced'
  // when synced_at is set, else 'partial' when incomplete (the two are disjoint).
  const doneLeads = schedulerLeads.filter(l => l.synced_at || l.is_partial)

  const schedByMonth: Record<string, { synced: number; partial: number }> = {}
  for (const l of doneLeads) {
    const ym = l.created_at?.slice(0, 7)
    if (!ym) continue
    if (!schedByMonth[ym]) schedByMonth[ym] = { synced: 0, partial: 0 }
    if (l.synced_at) schedByMonth[ym].synced++
    else schedByMonth[ym].partial++
  }
  const schedulingByMonth = Object.entries(schedByMonth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ym, v]) => ({ ym, label: monthLabelShort(ym), synced: v.synced, partial: v.partial }))

  // Resolve acknowledger names for the per-submission table.
  const ackByIds = [...new Set(doneLeads.map(l => l.acknowledged_by).filter((id): id is string => !!id))]
  const ackNameMap = new Map<string, string>()
  if (ackByIds.length > 0) {
    const { data: ackProfiles } = await db.from('profiles').select('id, full_name').in('id', ackByIds)
    for (const p of (ackProfiles ?? []) as { id: string; full_name: string | null }[]) {
      ackNameMap.set(p.id, p.full_name ?? '')
    }
  }
  const schedulingDone = [...doneLeads]
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
    .map(l => ({
      id: l.id,
      createdAt: l.created_at,
      customerName: [l.customer_first_name, l.customer_last_name].filter(Boolean).join(' ') || 'Unknown',
      serviceType: l.service_type,
      serviceCategory: l.service_category,
      appointmentDate: l.appointment_date,
      kind: (l.synced_at ? 'synced' : 'partial') as 'synced' | 'partial',
      sfJobId: l.service_fusion_job_id ?? null,
      acknowledgedAt: l.acknowledged_at,
      acknowledgedBy: l.acknowledged_by ? (ackNameMap.get(l.acknowledged_by) ?? null) : null,
    }))

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
  // month of work_completed_at (when the work was done; closed_at is only stamped
  // at invoicing — see migration 054). Using an RPC sidesteps PostgREST's
  // 1000-row response cap, which silently truncated the prior approach.
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

  // ── Revenue Outlook — four 12-month projections from the same monthly data ──
  // All methods exclude the in-progress month from their base (except method 1,
  // which extrapolates it by days elapsed). Basis: work-date revenue.
  const curYear  = Number(todayStr.slice(0, 4))
  const curMonth = Number(todayStr.slice(5, 7)) // 1-12
  const rev = (y: number, m: number) => jobsByYearMonth[`${y}-${String(m).padStart(2, '0')}`] ?? 0
  const revenueOutlook = (() => {
    if (curYear !== 2026) return null // projections are wired for the 2026 chart year
    const dayOfMonth   = Number(todayStr.slice(8, 10))
    const daysInMonth  = new Date(curYear, curMonth, 0).getDate()
    const completedMonths = Array.from({ length: curMonth - 1 }, (_, i) => i + 1)
    const futureMonths    = Array.from({ length: 12 - curMonth }, (_, i) => curMonth + 1 + i)
    const actualCompleted = completedMonths.reduce((s, m) => s + rev(2026, m), 0)
    const mtd = rev(2026, curMonth)

    // 1. Current-month pace: extrapolate the in-progress month by days elapsed.
    // Unstable in the first few days of a month — fall back to last completed month.
    const curMonthExtrap = dayOfMonth >= 5
      ? (mtd / dayOfMonth) * daysInMonth
      : rev(2026, curMonth - 1)
    const m1RunRate = curMonthExtrap * 12
    const m1Projected2026 = actualCompleted + curMonthExtrap * (12 - curMonth + 1)

    // 2. Trailing-3-month average (completed months only).
    const t3 = completedMonths.slice(-3)
    const t3avg = t3.length > 0 ? t3.reduce((s, m) => s + rev(2026, m), 0) / t3.length : 0
    const m2RunRate = t3avg * 12
    const m2Projected2026 = actualCompleted + t3avg * (12 - curMonth + 1)

    // 3. Seasonality-adjusted: monthly indices from 2025 (the only complete
    // year); de-seasonalize the last 3 completed months to find the current
    // level, then project each remaining month as level × its index.
    const avg2025 = Array.from({ length: 12 }, (_, i) => rev(2025, i + 1)).reduce((a, b) => a + b, 0) / 12
    const index = (m: number) => (avg2025 > 0 ? rev(2025, m) / avg2025 : 1)
    const levelSamples = t3.filter(m => index(m) > 0.1).map(m => rev(2026, m) / index(m))
    const level = levelSamples.length > 0 ? levelSamples.reduce((a, b) => a + b, 0) / levelSamples.length : t3avg
    const projMonth = (m: number) => level * index(m)
    const m3RunRate = level * 12
    const m3Projected2026 = actualCompleted + [curMonth, ...futureMonths].reduce((s, m) => s + projMonth(m), 0)

    // 4. Year-over-year pace: average growth across completed overlap months,
    // applied to 2025's remaining months. With only ~3 months of ownership this
    // may be rough — shown so it can be judged against the others.
    const overlap = completedMonths.filter(m => rev(2025, m) > 0)
    const growths = overlap.map(m => rev(2026, m) / rev(2025, m) - 1)
    const yoyGrowth = growths.length > 0 ? growths.reduce((a, b) => a + b, 0) / growths.length : 0
    const m4Projected2026 = actualCompleted + [curMonth, ...futureMonths].reduce((s, m) => s + rev(2025, m) * (1 + yoyGrowth), 0)
    const m4RunRate = m4Projected2026 // calendar-year figure doubles as the 12-mo view

    // Chart overlay: dashed projection from the last completed month through
    // December, using the seasonality-adjusted method (the only one with a
    // monthly shape; the straight-line methods are flat by construction).
    const projByMonth: (number | null)[] = MONTHS_SHORT.map((_, i) => {
      const m = i + 1
      if (m === curMonth - 1) return rev(2026, m)      // connect to last actual
      if (m === curMonth) return curMonthExtrap        // in-progress month, extrapolated
      if (m > curMonth) return projMonth(m)
      return null
    })

    return {
      methods: [
        { key: 'current', label: 'Current Month × 12', projected2026: m1Projected2026, runRate12: m1RunRate,
          note: dayOfMonth >= 5 ? `${MONTHS_SHORT[curMonth - 1]} pace, ${dayOfMonth} days in` : `using ${MONTHS_SHORT[curMonth - 2]} (month just started)` },
        { key: 't3', label: 'Trailing 3-Mo Avg × 12', projected2026: m2Projected2026, runRate12: m2RunRate,
          note: `${t3.map(m => MONTHS_SHORT[m - 1]).join(', ')} average` },
        { key: 'seasonal', label: 'Seasonality-Adjusted', projected2026: m3Projected2026, runRate12: m3RunRate,
          note: 'monthly shape from 2025' },
        { key: 'yoy', label: 'Year-over-Year Pace', projected2026: m4Projected2026, runRate12: m4RunRate,
          note: `${yoyGrowth >= 0 ? '+' : ''}${Math.round(yoyGrowth * 100)}% vs 2025 (${overlap.length} mo overlap)` },
      ],
      projByMonth,
    }
  })()

  const monthlyRevenue = MONTHS_SHORT.map((label, i) => {
    const m = String(i + 1).padStart(2, '0')
    return {
      month: label,
      revenue2025: jobsByYearMonth[`2025-${m}`] ?? 0,
      revenue2026: jobsByYearMonth[`2026-${m}`] ?? 0,
      projection: revenueOutlook?.projByMonth[i] ?? null,
    }
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
      schedulingDone={schedulingDone}
      techScoreboard={techScoreboard}
      lastSync={(lastSyncLog?.[0] as { sync_type: string; completed_at: string; records_synced: number } | undefined) ?? null}
      monthlyRevenue={monthlyRevenue}
      revenueOutlook={revenueOutlook ? { methods: revenueOutlook.methods } : null}
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
