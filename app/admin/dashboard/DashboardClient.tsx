'use client'

import { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import {
  ResponsiveContainer,
  LineChart,
  BarChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts'

interface Props {
  hasData: boolean
  snapshotMetrics: {
    revenueToday: number
    revenueTodayDelta: number
    revenueWeek: number
    avgDailyRevenue: number
    openJobsCount: number
    openEstimatesCount: number
    openEstimatesValue: number
    outstandingAR: number
  }
  capacityWeeks: { week: string; sameDayRate: number | null; medianLeadDays: number | null; totalJobs: number }[]
  rescheduleTrend: {
    trackingSince: string | null
    months: { month: string; rescheduleRate: number | null; partsRescheduleRate: number | null }[]
  }
  rescheduleDetail: {
    jobId: string
    number: string | null
    customer: string | null
    from: string | null
    to: string | null
    reason: string | null
    status: string | null
    observedAt: string | null
  }[]
  weeklyJobVolume: { week: number; jobs2025: number; jobs2026: number }[]
  techScoreboard: {
    techId: string
    techName: string | null
    jobsThisWeek: number
    revenueThisWeek: number
    avgTicketThisWeek: number
    baselineWeeklyRevenue: number
    revenueDeltaPct: number | null
  }[]
  lastSync: { sync_type: string; completed_at: string; records_synced: number } | null
  monthlyRevenue: { month: string; revenue2025: number; revenue2026: number }[]
  techMonthlyRevenue: { techId: string; techName: string; data: { yearMonth: string; revenue: number }[] }[]
}

const fmt$ = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)

function timeAgo(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime()
  const h = Math.floor(diff / 3_600_000)
  if (h < 1) return 'less than an hour ago'
  if (h === 1) return '1 hour ago'
  if (h < 24) return `${h} hours ago`
  const d = Math.floor(h / 24)
  return d === 1 ? '1 day ago' : `${d} days ago`
}

function formatWeekLabel(w: string): string {
  const d = new Date(w + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtReason(reason: string | null): string {
  if (!reason) return '—'
  return reason.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function formatMonthLabel(ym: string): string {
  const dt = new Date(ym + '-01T00:00:00')
  return dt.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
}

// Recent months as { value: 'YYYY-MM', label: 'July 2026' }, newest first.
function getRecentMonths(n: number): { value: string; label: string }[] {
  const now = new Date()
  const out: { value: string; label: string }[] = []
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    out.push({ value, label: d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) })
  }
  return out
}

interface MonthJobRow {
  id: string
  number: string | null
  customer: string | null
  source: string | null
  closedAt: string | null
  revenue: number
  amountDue: number
  techs: string[]
}

// Delta badge component
function DeltaBadge({ pct }: { pct: number }) {
  const isPos = pct >= 0
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded-full ${
        isPos ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'
      }`}
    >
      {isPos ? '↑' : '↓'} {Math.abs(pct).toFixed(1)}%
    </span>
  )
}

// Section card wrapper
function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-white border border-gray-200 rounded-lg p-4 ${className}`}>
      {children}
    </div>
  )
}

interface TechWeekRow {
  techId: string
  techName: string | null
  sfJobs: number
  sfRevenue: number
  avgTicket: number
  pieceworkPay: number | null
  profit: number | null
  marginPct: number | null
}

function getRecentMondays(n: number): string[] {
  const today = new Date()
  const day = today.getDay()
  const diff = day === 0 ? 6 : day - 1
  const monday = new Date(today)
  monday.setDate(today.getDate() - diff)
  monday.setHours(0, 0, 0, 0)
  const result: string[] = []
  for (let i = 0; i < n; i++) {
    const d = new Date(monday)
    d.setDate(monday.getDate() - i * 7)
    result.push(d.toISOString().slice(0, 10))
  }
  return result
}

function weekLabel(weekStart: string): string {
  const start = new Date(weekStart + 'T00:00:00')
  const end = new Date(weekStart + 'T00:00:00')
  end.setDate(end.getDate() + 6)
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${fmt(start)} – ${fmt(end)}`
}

// Backfill modal — processes one page per request, loops until done
function BackfillModal({ onClose }: { onClose: () => void }) {
  const ALL_ENTITIES = ['jobs', 'invoices', 'estimates', 'customers']
  const [selected, setSelected] = useState<string[]>(ALL_ENTITIES)
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{
    entity: string
    page: number
    pagesTotal: number
    records: number
    recordsTotal: number
    entityIndex: number
    entityCount: number
  } | null>(null)
  const cancelRef = useState({ cancelled: false })[0]

  function toggleEntity(e: string) {
    setSelected(prev => prev.includes(e) ? prev.filter(x => x !== e) : [...prev, e])
  }

  async function handleBackfill() {
    cancelRef.cancelled = false
    setRunning(true)
    setError(null)
    setDone(false)
    setProgress(null)

    const entitiesToRun = ALL_ENTITIES.filter(e => selected.includes(e))

    try {
      for (let ei = 0; ei < entitiesToRun.length; ei++) {
        const entity = entitiesToRun[ei]
        let logId: string | null = null
        let page = 1
        let pagesTotal = 1

        while (true) {
          if (cancelRef.cancelled) return

          // Phase 1: fetch one page from SF API (no DB writes)
          const fetchRes: Response = await fetch('/api/admin/analytics/backfill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phase: 'fetch', entity, page }),
          })
          if (!fetchRes.ok) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const j: any = await fetchRes.json().catch(() => ({}))
            throw new Error(j.error ?? `Fetch error HTTP ${fetchRes.status}`)
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const fetched: any = await fetchRes.json()
          pagesTotal = fetched.pages_total

          if (cancelRef.cancelled) return

          // Phase 2: write items to DB (no SF API call)
          const writeRes: Response = await fetch('/api/admin/analytics/backfill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              phase: 'write',
              entity,
              page,
              pages_total: pagesTotal,
              total_count: fetched.total_count,
              items: fetched.items,
              log_id: logId,
            }),
          })
          if (!writeRes.ok) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const j: any = await writeRes.json().catch(() => ({}))
            throw new Error(j.error ?? `Write error HTTP ${writeRes.status}`)
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const written: any = await writeRes.json()
          logId = written.log_id

          setProgress({
            entity,
            page,
            pagesTotal,
            records: written.records_synced,
            recordsTotal: written.records_total,
            entityIndex: ei + 1,
            entityCount: entitiesToRun.length,
          })

          if (written.done) break
          page++

          await new Promise(r => setTimeout(r, 200))
        }
      }

      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Backfill failed')
    } finally {
      setRunning(false)
    }
  }

  function handleCancel() {
    if (running) {
      cancelRef.cancelled = true
      setRunning(false)
      setError('Cancelled.')
    } else {
      onClose()
    }
  }

  const pct = progress && progress.pagesTotal > 0
    ? Math.round((progress.page / progress.pagesTotal) * 100)
    : 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg border border-gray-200 shadow-lg p-6 w-full max-w-sm mx-4">
        <h2 className="text-base font-bold text-gray-900 mb-3">Backfill Historical Data</h2>

        {done ? (
          <div className="space-y-3">
            <p className="text-sm text-green-700 font-medium">Backfill complete.</p>
            {progress && (
              <p className="text-xs text-gray-500">{progress.records.toLocaleString()} records synced.</p>
            )}
            <button onClick={onClose} className="w-full text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 px-4 py-2 rounded-md">
              Close
            </button>
          </div>
        ) : running ? (
          <div className="space-y-3">
            {progress && (
              <>
                <p className="text-sm text-gray-700 font-medium capitalize">
                  {progress.entity} — page {progress.page} of {progress.pagesTotal}
                  {progress.entityCount > 1 && (
                    <span className="text-gray-400 font-normal"> (entity {progress.entityIndex}/{progress.entityCount})</span>
                  )}
                </p>
                <div className="w-full bg-gray-100 rounded-full h-2">
                  <div
                    className="bg-red-600 h-2 rounded-full transition-all duration-300"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <p className="text-xs text-gray-500">
                  {progress.records.toLocaleString()} / {progress.recordsTotal.toLocaleString()} records
                </p>
              </>
            )}
            {!progress && <p className="text-sm text-gray-500">Starting…</p>}
            <button
              onClick={handleCancel}
              className="w-full text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 px-4 py-2 rounded-md"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">Select entities to backfill:</p>
            <div className="space-y-2">
              {ALL_ENTITIES.map(e => (
                <label key={e} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.includes(e)}
                    onChange={() => toggleEntity(e)}
                    className="accent-red-600"
                  />
                  {e.charAt(0).toUpperCase() + e.slice(1)}
                </label>
              ))}
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex gap-2 pt-1">
              <button
                onClick={handleBackfill}
                disabled={selected.length === 0}
                className="flex-1 text-sm bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-md disabled:opacity-50 font-medium"
              >
                Start backfill
              </button>
              <button
                onClick={onClose}
                className="flex-1 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 px-4 py-2 rounded-md"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const TECH_COLORS = ['#6366f1','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316','#84cc16','#ec4899','#14b8a6']
const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

export default function DashboardClient({
  hasData,
  snapshotMetrics,
  capacityWeeks,
  rescheduleTrend,
  rescheduleDetail,
  weeklyJobVolume,
  techScoreboard,
  lastSync,
  monthlyRevenue,
  techMonthlyRevenue,
}: Props) {
  const router = useRouter()
  const [syncing, setSyncing] = useState(false)
  const [showBackfill, setShowBackfill] = useState(false)

  // Tech scoreboard — week selector + client-side fetch
  const weekOptions = getRecentMondays(13)
  const [techWeekStart, setTechWeekStart] = useState(weekOptions[0])
  const [techWeekRows, setTechWeekRows] = useState<TechWeekRow[] | null>(null)
  const [techWeekLoading, setTechWeekLoading] = useState(false)
  const [techChartYear, setTechChartYear] = useState<2025 | 2026>(new Date().getFullYear() >= 2026 ? 2026 : 2025)
  const [hiddenRevLines, setHiddenRevLines] = useState<Set<string>>(new Set())
  const [hiddenVolLines, setHiddenVolLines] = useState<Set<string>>(new Set())

  const fetchTechWeek = useCallback(async (wk: string) => {
    setTechWeekLoading(true)
    try {
      const res = await fetch(`/api/admin/analytics/tech-week?weekStart=${wk}`)
      if (res.ok) {
        const data = await res.json()
        setTechWeekRows(data.rows ?? [])
      }
    } finally {
      setTechWeekLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchTechWeek(techWeekStart)
  }, [techWeekStart, fetchTechWeek])

  // Month-detail table (bottom section) — month picker + client fetch.
  const monthOptions = getRecentMonths(18)
  const [detailMonth, setDetailMonth] = useState(monthOptions[0].value)
  const [monthRows, setMonthRows] = useState<MonthJobRow[] | null>(null)
  const [monthTotals, setMonthTotals] = useState<{ count: number; totalRevenue: number; totalDue: number } | null>(null)
  const [monthLoading, setMonthLoading] = useState(false)

  const fetchMonthJobs = useCallback(async (m: string) => {
    setMonthLoading(true)
    try {
      const res = await fetch(`/api/admin/dashboard/jobs-by-month?month=${m}`)
      if (res.ok) {
        const data = await res.json()
        setMonthRows(data.rows ?? [])
        setMonthTotals({ count: data.count ?? 0, totalRevenue: data.totalRevenue ?? 0, totalDue: data.totalDue ?? 0 })
      }
    } finally {
      setMonthLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchMonthJobs(detailMonth)
  }, [detailMonth, fetchMonthJobs])

  const handleSync = useCallback(async () => {
    setSyncing(true)
    try {
      const res = await fetch('/api/admin/analytics/sync', { method: 'POST' })
      if (res.ok) router.refresh()
    } finally {
      setSyncing(false)
    }
  }, [router])

  const capacityHealth = capacityHealth_calc(capacityWeeks)

  // Prepare capacity chart data — filter nulls for rendering
  const sameDayChartData = capacityWeeks.map(w => ({
    week: formatWeekLabel(w.week),
    sameDayRate: w.sameDayRate !== null ? +(w.sameDayRate * 100).toFixed(1) : null,
    totalJobs: w.totalJobs,
  }))

  const leadTimeChartData = capacityWeeks.map(w => ({
    week: formatWeekLabel(w.week),
    medianLeadDays: w.medianLeadDays !== null ? +w.medianLeadDays.toFixed(1) : null,
  }))

  const reschedChartData = rescheduleTrend.months.map(m => ({
    month: formatMonthLabel(m.month),
    rescheduleRate: m.rescheduleRate !== null ? +(m.rescheduleRate * 100).toFixed(1) : null,
    partsRescheduleRate: m.partsRescheduleRate !== null ? +(m.partsRescheduleRate * 100).toFixed(1) : null,
  }))

  return (
    <div className="space-y-6">
      {showBackfill && <BackfillModal onClose={() => setShowBackfill(false)} />}

      {/* Section 0 — Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Analytics Dashboard</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            {lastSync ? `Last synced: ${timeAgo(lastSync.completed_at)}` : 'Never synced'}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleSync}
            disabled={syncing}
            className="text-sm bg-white border border-gray-300 hover:border-gray-400 text-gray-700 px-3 py-1.5 rounded-md disabled:opacity-50 font-medium transition-colors"
          >
            {syncing ? 'Syncing…' : '↻ Refresh now'}
          </button>
          <button
            onClick={() => setShowBackfill(true)}
            className="text-sm bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded-md font-medium transition-colors"
          >
            Backfill historical data
          </button>
        </div>
      </div>

      {/* No-data empty state */}
      {!hasData && (
        <Card className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-gray-500 text-sm mb-4">
            No data yet. Run the historical backfill to populate the dashboard.
          </p>
          <button
            onClick={() => setShowBackfill(true)}
            className="text-sm bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-md font-medium"
          >
            Backfill historical data
          </button>
        </Card>
      )}

      {hasData && (
        <>
          {/* Section 1 — Snapshot strip */}
          <div>
            <h2 className="text-sm font-semibold text-gray-700 mb-2">Snapshot</h2>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {/* Revenue Today */}
              <Card>
                <p className="text-xs text-gray-500 mb-1">Revenue Today</p>
                <p className="text-2xl font-bold text-gray-900">{fmt$(snapshotMetrics.revenueToday)}</p>
                <div className="mt-1">
                  <DeltaBadge pct={snapshotMetrics.revenueTodayDelta} />
                  <span className="text-xs text-gray-400 ml-1">vs 28d avg</span>
                </div>
              </Card>

              {/* Revenue This Week */}
              <Card>
                <p className="text-xs text-gray-500 mb-1">Revenue This Week</p>
                <p className="text-2xl font-bold text-gray-900">{fmt$(snapshotMetrics.revenueWeek)}</p>
                <p className="text-xs text-gray-400 mt-1">
                  Avg/day: {fmt$(snapshotMetrics.avgDailyRevenue)}
                </p>
              </Card>

              {/* Open Jobs */}
              <Card>
                <p className="text-xs text-gray-500 mb-1">Open Jobs in Progress</p>
                <p className="text-2xl font-bold text-gray-900">{snapshotMetrics.openJobsCount}</p>
              </Card>

              {/* Open Estimates */}
              <Card>
                <p className="text-xs text-gray-500 mb-1">Open Estimates</p>
                <p className="text-2xl font-bold text-gray-900">{snapshotMetrics.openEstimatesCount}</p>
                <p className="text-xs text-gray-400 mt-1">{fmt$(snapshotMetrics.openEstimatesValue)} total value</p>
              </Card>

              {/* Outstanding A/R — links to Action Items > Unpaid Jobs */}
              <a href="/admin/action-items" className="col-span-2 lg:col-span-4 block">
                <Card className="cursor-pointer hover:bg-gray-50 transition-colors">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs text-gray-500 mb-1">Outstanding A/R</p>
                      <p className="text-2xl font-bold text-gray-900">{fmt$(snapshotMetrics.outstandingAR)}</p>
                    </div>
                    <span className="text-xs text-indigo-600 font-medium">View unpaid jobs →</span>
                  </div>
                </Card>
              </a>
            </div>
          </div>

          {/* Section 3 — Monthly Revenue */}
          <div>
            <h2 className="text-sm font-semibold text-gray-700 mb-2">Monthly Revenue</h2>
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={monthlyRevenue} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis dataKey="month" tick={{ fontSize: 11 }} tickLine={false} />
                    <YAxis
                      tick={{ fontSize: 10 }}
                      tickFormatter={v => `$${(v / 1000).toFixed(0)}k`}
                      width={44}
                    />
                    <Tooltip formatter={(v) => typeof v === 'number' ? fmt$(v) : v} />
                    <Legend
                      wrapperStyle={{ fontSize: 12, cursor: 'pointer' }}
                      onClick={(e) => {
                        const key = e.dataKey as string
                        setHiddenRevLines(prev => {
                          const next = new Set(prev)
                          next.has(key) ? next.delete(key) : next.add(key)
                          return next
                        })
                      }}
                      formatter={(value, entry) => (
                        <span style={{ color: hiddenRevLines.has((entry as { dataKey?: string }).dataKey ?? '') ? '#d1d5db' : '#374151' }}>
                          {value}
                        </span>
                      )}
                    />
                    <Line type="monotone" dataKey="revenue2025" name="2025" stroke="#6366f1" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} connectNulls={false} hide={hiddenRevLines.has('revenue2025')} />
                    <Line type="monotone" dataKey="revenue2026" name="2026" stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} connectNulls={false} hide={hiddenRevLines.has('revenue2026')} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* Section 4 — Revenue by Tech */}
          {techMonthlyRevenue.length > 0 && (() => {
            const techBarData = MONTH_LABELS.map((label, i) => {
              const ym = `${techChartYear}-${String(i + 1).padStart(2, '0')}`
              const row: Record<string, number | string> = { month: label }
              for (const tech of techMonthlyRevenue) {
                const entry = tech.data.find(d => d.yearMonth === ym)
                row[tech.techName] = entry?.revenue ?? 0
              }
              return row
            })
            return (
              <div>
                <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
                  <h2 className="text-sm font-semibold text-gray-700">Revenue by Tech</h2>
                  <div className="flex gap-1">
                    {([2025, 2026] as const).map(y => (
                      <button
                        key={y}
                        onClick={() => setTechChartYear(y)}
                        className={`px-3 py-1 text-xs rounded-full font-medium transition-colors ${techChartYear === y ? 'bg-indigo-100 text-indigo-700' : 'text-gray-500 hover:text-gray-700'}`}
                      >
                        {y}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="bg-white border border-gray-200 rounded-lg p-4">
                  <div className="h-72">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={techBarData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                        <XAxis dataKey="month" tick={{ fontSize: 11 }} tickLine={false} />
                        <YAxis
                          tick={{ fontSize: 10 }}
                          tickFormatter={v => `$${(v / 1000).toFixed(0)}k`}
                          width={44}
                        />
                        <Tooltip formatter={(v) => typeof v === 'number' ? fmt$(v) : v} />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        {techMonthlyRevenue.map((tech, i) => (
                          <Bar key={tech.techId} dataKey={tech.techName} fill={TECH_COLORS[i % TECH_COLORS.length]} radius={[2, 2, 0, 0]} />
                        ))}
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            )
          })()}

          {/* Section 5 — Capacity Indicators */}
          <div>
            <h2 className="text-sm font-semibold text-gray-700 mb-2">Capacity Indicators</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Same-day rate */}
              <Card>
                <p className="text-xs font-medium text-gray-700 mb-2">Same-Day Service Rate (Weekly)</p>
                <div className="h-44">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={sameDayChartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="week" tick={{ fontSize: 10 }} tickLine={false} />
                      <YAxis
                        tick={{ fontSize: 10 }}
                        tickFormatter={v => `${v}%`}
                        domain={[0, 100]}
                        width={36}
                      />
                      <Tooltip formatter={(v: any) => [`${v}%`, 'Same-day rate']} />
                      <Line
                        type="monotone"
                        dataKey="sameDayRate"
                        stroke="#dc2626"
                        strokeWidth={1.5}
                        dot={{ r: 3 }}
                        connectNulls={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <p className={`text-xs font-medium mt-2 ${capacityHealth.color}`}>{capacityHealth.text}</p>
              </Card>

              {/* Median lead time */}
              <Card>
                <p className="text-xs font-medium text-gray-700 mb-2">Median Lead Time (Days)</p>
                <div className="h-44">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={leadTimeChartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="week" tick={{ fontSize: 10 }} tickLine={false} />
                      <YAxis
                        tick={{ fontSize: 10 }}
                        tickFormatter={v => `${v}d`}
                        width={36}
                      />
                      <Tooltip formatter={(v: any) => [`${v} days`, 'Median lead time']} />
                      <Line
                        type="monotone"
                        dataKey="medianLeadDays"
                        stroke="#2563eb"
                        strokeWidth={1.5}
                        dot={{ r: 3 }}
                        connectNulls={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </Card>

              {/* Reschedule rate (monthly) + detail table */}
              <Card className="md:col-span-2">
                <p className="text-xs font-medium text-gray-700 mb-2">Reschedule Rate (Monthly)</p>
                <div className="h-44">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={reschedChartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="month" tick={{ fontSize: 10 }} tickLine={false} />
                      <YAxis
                        tick={{ fontSize: 10 }}
                        tickFormatter={v => `${v}%`}
                        width={36}
                      />
                      <Tooltip formatter={(v: any, name: any) => [
                        `${v}%`,
                        name === 'rescheduleRate' ? 'Total reschedule rate' : 'Parts/incomplete rate',
                      ]} />
                      <Legend
                        formatter={(value: string) =>
                          value === 'rescheduleRate' ? 'Total reschedule' : 'Parts/incomplete'
                        }
                        wrapperStyle={{ fontSize: 11 }}
                      />
                      <Line
                        type="monotone"
                        dataKey="rescheduleRate"
                        stroke="#6b7280"
                        strokeWidth={1.5}
                        dot={{ r: 3 }}
                        connectNulls={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="partsRescheduleRate"
                        stroke="#f97316"
                        strokeWidth={1.5}
                        dot={{ r: 3 }}
                        connectNulls={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                {rescheduleTrend.trackingSince && (
                  <p className="text-xs text-gray-400 mt-1">Tracking since {rescheduleTrend.trackingSince}</p>
                )}

                {/* Reschedule detail table */}
                <div className="mt-4 border-t border-gray-100 pt-3">
                  <p className="text-xs font-medium text-gray-700 mb-2">Rescheduled Jobs (detail)</p>
                  {rescheduleDetail.length === 0 ? (
                    <p className="text-sm text-gray-400 py-3 text-center">No reschedules recorded.</p>
                  ) : (
                    <div className="overflow-x-auto max-h-96 overflow-y-auto">
                      <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-white">
                          <tr className="border-b border-gray-100">
                            <th className="text-left py-2 px-3 text-xs font-medium text-gray-500">Job #</th>
                            <th className="text-left py-2 px-3 text-xs font-medium text-gray-500">Customer</th>
                            <th className="text-left py-2 px-3 text-xs font-medium text-gray-500">From</th>
                            <th className="text-left py-2 px-3 text-xs font-medium text-gray-500">To</th>
                            <th className="text-left py-2 px-3 text-xs font-medium text-gray-500">Reason</th>
                            <th className="text-left py-2 px-3 text-xs font-medium text-gray-500">When</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                          {rescheduleDetail.map((r, i) => (
                            <tr key={`${r.jobId}-${i}`} className="hover:bg-gray-50">
                              <td className="py-2 px-3 text-xs font-medium text-gray-700">{r.number ?? '—'}</td>
                              <td className="py-2 px-3 text-xs text-gray-700">{r.customer ?? '—'}</td>
                              <td className="py-2 px-3 text-xs text-gray-500">{fmtDateTime(r.from)}</td>
                              <td className="py-2 px-3 text-xs text-gray-500">{fmtDateTime(r.to)}</td>
                              <td className="py-2 px-3 text-xs text-gray-500">{fmtReason(r.reason)}</td>
                              <td className="py-2 px-3 text-xs text-gray-400">{fmtDateTime(r.observedAt)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </Card>

              {/* Weekly Job Volume — completed jobs per week, 2025 vs 2026 */}
              <Card className="md:col-span-2">
                <p className="text-xs font-medium text-gray-700 mb-2">Weekly Job Volume</p>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={weeklyJobVolume} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="week" tick={{ fontSize: 10 }} tickLine={false} interval={3} tickFormatter={v => `W${v}`} />
                      <YAxis tick={{ fontSize: 10 }} width={30} allowDecimals={false} />
                      <Tooltip
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        formatter={(v: any, name: any) => [v, name]}
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        labelFormatter={(w: any) => `Week ${w}`}
                      />
                      <Legend
                        wrapperStyle={{ fontSize: 12, cursor: 'pointer' }}
                        onClick={(e) => {
                          const key = e.dataKey as string
                          setHiddenVolLines(prev => {
                            const next = new Set(prev)
                            next.has(key) ? next.delete(key) : next.add(key)
                            return next
                          })
                        }}
                        formatter={(value, entry) => (
                          <span style={{ color: hiddenVolLines.has((entry as { dataKey?: string }).dataKey ?? '') ? '#d1d5db' : '#374151' }}>
                            {value}
                          </span>
                        )}
                      />
                      <Line type="monotone" dataKey="jobs2025" name="2025" stroke="#6366f1" strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls={false} hide={hiddenVolLines.has('jobs2025')} />
                      <Line type="monotone" dataKey="jobs2026" name="2026" stroke="#10b981" strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls={false} hide={hiddenVolLines.has('jobs2026')} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <p className="text-xs text-gray-400 mt-1">Completed jobs per week of the year.</p>
              </Card>
            </div>
          </div>

          {/* Section 6 — Tech Scoreboard */}
          <div>
            <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
              <h2 className="text-sm font-semibold text-gray-700">Tech Scoreboard</h2>
              <select
                value={techWeekStart}
                onChange={e => setTechWeekStart(e.target.value)}
                className="text-xs border border-gray-300 rounded-md px-2 py-1.5 text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-red-400"
              >
                {weekOptions.map(w => (
                  <option key={w} value={w}>{weekLabel(w)}</option>
                ))}
              </select>
            </div>
            <Card>
              {techWeekLoading ? (
                <p className="text-sm text-gray-400 py-4 text-center">Loading…</p>
              ) : techWeekRows === null || techWeekRows.length === 0 ? (
                <p className="text-sm text-gray-400 py-4 text-center">No tech data for this week yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th className="text-left py-2 px-3 text-xs font-medium text-gray-500">Tech</th>
                        <th className="text-right py-2 px-3 text-xs font-medium text-gray-500">Jobs</th>
                        <th className="text-right py-2 px-3 text-xs font-medium text-gray-500">Revenue</th>
                        <th className="text-right py-2 px-3 text-xs font-medium text-gray-500">Avg Ticket</th>
                        <th className="text-right py-2 px-3 text-xs font-medium text-gray-500">Labor</th>
                        <th className="text-right py-2 px-3 text-xs font-medium text-gray-500">Profit</th>
                        <th className="text-right py-2 px-3 text-xs font-medium text-gray-500">Margin</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {techWeekRows.map(row => {
                        const marginOk = row.marginPct !== null && row.marginPct >= 40
                        const marginWarn = row.marginPct !== null && row.marginPct >= 20 && row.marginPct < 40
                        const marginBad = row.marginPct !== null && row.marginPct < 20
                        return (
                          <tr
                            key={row.techId}
                            onClick={() => router.push(`/admin/dashboard/tech/${encodeURIComponent(row.techId)}?weekStart=${techWeekStart}`)}
                            className="cursor-pointer hover:bg-gray-50 transition-colors"
                          >
                            <td className="py-2 px-3 font-medium text-gray-700 text-xs">{row.techName ?? row.techId}</td>
                            <td className="py-2 px-3 text-right text-gray-700">{row.sfJobs}</td>
                            <td className="py-2 px-3 text-right text-gray-700">{fmt$(row.sfRevenue)}</td>
                            <td className="py-2 px-3 text-right text-gray-500">{fmt$(row.avgTicket)}</td>
                            <td className="py-2 px-3 text-right text-gray-500">
                              {row.pieceworkPay !== null ? fmt$(row.pieceworkPay) : <span className="text-gray-300">—</span>}
                            </td>
                            <td className="py-2 px-3 text-right font-medium">
                              {row.profit !== null ? (
                                <span className={row.profit >= 0 ? 'text-green-700' : 'text-red-600'}>
                                  {fmt$(row.profit)}
                                </span>
                              ) : <span className="text-gray-300">—</span>}
                            </td>
                            <td className="py-2 px-3 text-right">
                              {row.marginPct !== null ? (
                                <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full ${
                                  marginOk ? 'bg-green-50 text-green-700' :
                                  marginWarn ? 'bg-yellow-50 text-yellow-700' :
                                  marginBad ? 'bg-red-50 text-red-600' : ''
                                }`}>
                                  {row.marginPct.toFixed(1)}%
                                </span>
                              ) : <span className="text-gray-300 text-xs">—</span>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  <p className="text-xs text-gray-400 mt-3 px-3">
                    Labor = piecework pay submitted for the week. Dashes mean no piecework submitted yet.
                  </p>
                </div>
              )}
            </Card>
          </div>

          {/* Section 7 — Jobs by Month (detail table) */}
          <div>
            <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
              <h2 className="text-sm font-semibold text-gray-700">Jobs by Month</h2>
              <select
                value={detailMonth}
                onChange={e => setDetailMonth(e.target.value)}
                className="text-xs border border-gray-300 rounded-md px-2 py-1.5 text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-red-400"
              >
                {monthOptions.map(m => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
            <Card>
              {monthLoading ? (
                <p className="text-sm text-gray-400 py-4 text-center">Loading…</p>
              ) : monthRows === null || monthRows.length === 0 ? (
                <p className="text-sm text-gray-400 py-4 text-center">No jobs closed in this month.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th className="text-left py-2 px-3 text-xs font-medium text-gray-500">Customer</th>
                        <th className="text-left py-2 px-3 text-xs font-medium text-gray-500">Job #</th>
                        <th className="text-left py-2 px-3 text-xs font-medium text-gray-500">Source</th>
                        <th className="text-left py-2 px-3 text-xs font-medium text-gray-500">Closed</th>
                        <th className="text-right py-2 px-3 text-xs font-medium text-gray-500">Revenue</th>
                        <th className="text-right py-2 px-3 text-xs font-medium text-gray-500">Amount Due</th>
                        <th className="text-left py-2 px-3 text-xs font-medium text-gray-500">Tech(s)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {monthRows.map(r => (
                        <tr key={r.id} className="hover:bg-gray-50">
                          <td className="py-2 px-3 text-xs text-gray-700">{r.customer ?? '—'}</td>
                          <td className="py-2 px-3 text-xs font-medium text-gray-700">{r.number ?? '—'}</td>
                          <td className="py-2 px-3 text-xs text-gray-500">{r.source ?? '—'}</td>
                          <td className="py-2 px-3 text-xs text-gray-500">{fmtDateTime(r.closedAt)}</td>
                          <td className="py-2 px-3 text-right text-xs text-gray-700">{fmt$(r.revenue)}</td>
                          <td className={`py-2 px-3 text-right text-xs ${r.amountDue > 0 ? 'text-red-600 font-medium' : 'text-gray-400'}`}>
                            {fmt$(r.amountDue)}
                          </td>
                          <td className="py-2 px-3 text-xs text-gray-500">{r.techs.length > 0 ? r.techs.join(', ') : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                    {monthTotals && (
                      <tfoot>
                        <tr className="border-t border-gray-200 font-medium">
                          <td className="py-2 px-3 text-xs text-gray-700" colSpan={4}>{monthTotals.count} jobs</td>
                          <td className="py-2 px-3 text-right text-xs text-gray-900">{fmt$(monthTotals.totalRevenue)}</td>
                          <td className="py-2 px-3 text-right text-xs text-gray-900">{fmt$(monthTotals.totalDue)}</td>
                          <td></td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  )
}

// Extracted as a named function to avoid conflict with variable name
function capacityHealth_calc(capacityWeeks: Props['capacityWeeks']): { color: string; text: string } {
  const last4 = capacityWeeks.slice(-4).filter(w => w.sameDayRate !== null)
  if (last4.length < 2) return { color: 'text-gray-500', text: '– Not enough data yet' }
  const avg = last4.reduce((s, w) => s + (w.sameDayRate ?? 0), 0) / last4.length
  if (avg > 0.7) return { color: 'text-green-700', text: '✓ Capacity looks healthy' }
  if (avg >= 0.5) return { color: 'text-yellow-700', text: '⚠ Watch capacity — same-day rate trending down' }
  return { color: 'text-gray-500', text: '– Not enough data yet' }
}
