import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import DashboardClient from './DashboardClient'

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

  // TODO: replace with imports from @/lib/analytics/metrics once that file is available
  // For now fetch raw data inline and pass to client

  const [
    { data: recentInvoices },
    { count: openJobsCount },
    { data: openEstimates },
    { data: arData },
    { data: revenueDays },
    { data: completedJobs },
    { data: capacityJobs },
    { data: schedHistory },
    { data: annotations },
    { count: backlogCount },
    { data: lastSyncLog },
  ] = await Promise.all([
    db.from('sf_invoices_cache').select('issued_at, total').gte('issued_at', daysAgo(90)),
    db.from('sf_jobs_cache').select('id', { count: 'exact', head: true }).eq('is_closed', false),
    db.from('sf_estimates_cache').select('id, total, status').not('status', 'in', '("accepted","declined","Accepted","Declined")'),
    db.from('sf_invoices_cache').select('balance_due').gt('balance_due', 0),
    db.from('sf_invoices_cache').select('issued_at, total').gte('issued_at', daysAgo(90)).order('issued_at'),
    db.from('sf_jobs_cache').select('completed_at').eq('is_closed', true).gte('completed_at', daysAgo(90)).not('completed_at', 'is', null),
    db.from('sf_jobs_cache').select('completed_at, original_scheduled_at').eq('is_closed', true).gte('completed_at', daysAgo(90)).not('completed_at', 'is', null).not('original_scheduled_at', 'is', null),
    db.from('sf_job_schedule_history').select('sf_job_id, change_type, reschedule_reason, observed_at').gte('observed_at', daysAgo(90)).order('observed_at'),
    db.from('dashboard_annotations').select('*').order('occurred_on'),
    db.from('sf_jobs_cache').select('id', { count: 'exact', head: true }).eq('is_closed', false).gte('scheduled_at', today()).lte('scheduled_at', daysAgo(-7)),
    db.from('analytics_sync_log').select('sync_type, status, completed_at, records_synced').eq('status', 'complete').order('completed_at', { ascending: false }).limit(1),
  ])

  // Compute snapshot
  const todayStr = today()
  const todayInvoices = (recentInvoices ?? []).filter((r: { issued_at?: string | null; total?: number | null }) => r.issued_at?.slice(0, 10) === todayStr)
  const revenueToday = todayInvoices.reduce((s: number, r: { total?: number | null }) => s + (r.total ?? 0), 0)

  const trailing28 = (recentInvoices ?? []).filter((r: { issued_at?: string | null }) => (r.issued_at ?? '') >= daysAgo(28))
  const dailyTotals: Record<string, number> = {}
  for (const r of trailing28 as { issued_at?: string | null; total?: number | null }[]) {
    const d = r.issued_at?.slice(0, 10) ?? ''
    if (d) dailyTotals[d] = (dailyTotals[d] ?? 0) + (r.total ?? 0)
  }
  const dailyValues = Object.values(dailyTotals)
  const avgDailyRevenue = dailyValues.length > 0 ? dailyValues.reduce((a, b) => a + b, 0) / dailyValues.length : 0

  const weekInvoices = (recentInvoices ?? []).filter((r: { issued_at?: string | null }) => (r.issued_at ?? '') >= daysAgo(7))
  const revenueWeek = weekInvoices.reduce((s: number, r: { total?: number | null }) => s + (r.total ?? 0), 0)

  const outstandingAR = (arData ?? []).reduce((s: number, r: { balance_due?: number | null }) => s + (r.balance_due ?? 0), 0)
  const openEstimatesValue = (openEstimates ?? []).reduce((s: number, r: { total?: number | null }) => s + (r.total ?? 0), 0)

  // Build revenue trend
  const revByDay: Record<string, number> = {}
  for (const r of (revenueDays ?? []) as { issued_at?: string | null; total?: number | null }[]) {
    const d = r.issued_at?.slice(0, 10) ?? ''
    if (d) revByDay[d] = (revByDay[d] ?? 0) + (r.total ?? 0)
  }
  const revenueTrend = buildDayArray(90).map((date, i, arr) => {
    const revenue = revByDay[date] ?? 0
    const rolling28 = i >= 27 ? arr.slice(i - 27, i + 1).reduce((s, d) => s + (revByDay[d] ?? 0), 0) / 28 : null
    return { date, revenue, rolling28 }
  })

  // Jobs trend
  const jobsByDay: Record<string, number> = {}
  for (const r of (completedJobs ?? []) as { completed_at?: string | null }[]) {
    const d = r.completed_at?.slice(0, 10) ?? ''
    if (d) jobsByDay[d] = (jobsByDay[d] ?? 0) + 1
  }
  const jobsTrend = buildDayArray(90).map((date, i, arr) => {
    const jobs = jobsByDay[date] ?? 0
    const rolling28 = i >= 27 ? arr.slice(i - 27, i + 1).reduce((s, d) => s + (jobsByDay[d] ?? 0), 0) / 28 : null
    return { date, jobs, rolling28 }
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

  // Reschedule trend
  const schedHistoryTyped = (schedHistory ?? []) as { sf_job_id?: string | null; change_type?: string | null; reschedule_reason?: string | null; observed_at?: string | null }[]
  const firstInitial = schedHistoryTyped.find(r => r.change_type === 'initial')
  const trackingSince = firstInitial?.observed_at?.slice(0, 10) ?? null
  type RWeek = { rescheduled: number; partsRescheduled: number; totalInitial: number }
  const reschedByWeek: Record<string, RWeek> = {}
  for (const row of schedHistoryTyped) {
    if (!row.observed_at) continue
    const w = weekStartStr(new Date(row.observed_at))
    if (!reschedByWeek[w]) reschedByWeek[w] = { rescheduled: 0, partsRescheduled: 0, totalInitial: 0 }
    if (row.change_type === 'initial') reschedByWeek[w].totalInitial++
    if (row.change_type === 'rescheduled') {
      reschedByWeek[w].rescheduled++
      if (row.reschedule_reason === 'parts_or_incomplete') reschedByWeek[w].partsRescheduled++
    }
  }
  const rescheduleTrend = {
    trackingSince,
    weeks: Object.entries(reschedByWeek).sort(([a], [b]) => a.localeCompare(b)).map(([week, v]) => ({
      week,
      rescheduleRate: v.totalInitial > 0 ? v.rescheduled / v.totalInitial : null,
      partsRescheduleRate: v.totalInitial > 0 ? v.partsRescheduled / v.totalInitial : null,
    })),
  }

  // Pipeline buckets
  const now = Date.now()
  const buckets = { fresh: 0, aging: 0, old: 0, freshValue: 0, agingValue: 0, oldValue: 0 }
  for (const est of (openEstimates ?? []) as { total?: number | null; created_at_sf?: string | null }[]) {
    const age = est.created_at_sf ? (now - new Date(est.created_at_sf).getTime()) / 86_400_000 : 999
    const val = est.total ?? 0
    if (age <= 7) { buckets.fresh++; buckets.freshValue += val }
    else if (age <= 30) { buckets.aging++; buckets.agingValue += val }
    else { buckets.old++; buckets.oldValue += val }
  }

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
      revenueTrend={revenueTrend}
      jobsTrend={jobsTrend}
      capacityWeeks={capacityWeeks}
      rescheduleTrend={rescheduleTrend}
      techScoreboard={[]}
      pipeline={{ totalOpen: openEstimates?.length ?? 0, totalValue: openEstimatesValue, buckets }}
      annotations={(annotations ?? []) as { id: string; occurred_on: string; title: string; note: string | null }[]}
      backlog={{ count: backlogCount ?? 0 }}
      lastSync={(lastSyncLog?.[0] as { sync_type: string; completed_at: string; records_synced: number } | undefined) ?? null}
    />
  )
}

function today(): string { return new Date().toISOString().slice(0, 10) }
function daysAgo(n: number): string { return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10) }
function buildDayArray(days: number): string[] {
  return Array.from({ length: days + 1 }, (_, i) => daysAgo(days - i))
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
