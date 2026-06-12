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
  ReferenceLine,
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
  revenueTrend: { date: string; revenue: number; rolling28: number | null }[]
  jobsTrend: { date: string; jobs: number; rolling28: number | null }[]
  capacityWeeks: { week: string; sameDayRate: number | null; medianLeadDays: number | null; totalJobs: number }[]
  rescheduleTrend: {
    trackingSince: string | null
    weeks: { week: string; rescheduleRate: number | null; partsRescheduleRate: number | null }[]
  }
  techScoreboard: {
    techId: string
    techName: string | null
    jobsThisWeek: number
    revenueThisWeek: number
    avgTicketThisWeek: number
    baselineWeeklyRevenue: number
    revenueDeltaPct: number | null
  }[]
  pipeline: {
    totalOpen: number
    totalValue: number
    buckets: { fresh: number; aging: number; old: number; freshValue: number; agingValue: number; oldValue: number }
  }
  annotations: { id: string; occurred_on: string; title: string; note: string | null }[]
  backlog: { count: number }
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

function formatDateLabel(d: string): string {
  const dt = new Date(d + 'T00:00:00')
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
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

// Chart legend
function ChartLegend() {
  return (
    <div className="flex items-center gap-4 text-xs text-gray-500 mt-1">
      <span className="flex items-center gap-1"><span className="inline-block w-6 border-t-2 border-red-500"></span> Actual</span>
      <span className="flex items-center gap-1"><span className="inline-block w-6 border-t-2 border-dashed border-gray-400"></span> 28d avg</span>
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
  revenueTrend,
  jobsTrend,
  capacityWeeks,
  rescheduleTrend,
  techScoreboard,
  pipeline,
  annotations,
  backlog,
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

  // Annotations state (local editable copy)
  const [annotationList, setAnnotationList] = useState(annotations)
  const [newDate, setNewDate] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [newNote, setNewNote] = useState('')
  const [savingAnnotation, setSavingAnnotation] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDate, setEditDate] = useState('')
  const [editTitle, setEditTitle] = useState('')
  const [editNote, setEditNote] = useState('')

  const handleSync = useCallback(async () => {
    setSyncing(true)
    try {
      const res = await fetch('/api/admin/analytics/sync', { method: 'POST' })
      if (res.ok) router.refresh()
    } finally {
      setSyncing(false)
    }
  }, [router])

  async function fetchAnnotations() {
    const res = await fetch('/api/admin/analytics/annotations')
    if (res.ok) {
      const data = await res.json()
      setAnnotationList(data.annotations ?? [])
    }
  }

  async function handleAddAnnotation(e: React.FormEvent) {
    e.preventDefault()
    if (!newDate || !newTitle) return
    setSavingAnnotation(true)
    try {
      const res = await fetch('/api/admin/analytics/annotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ occurred_on: newDate, title: newTitle, note: newNote || null }),
      })
      if (res.ok) {
        setNewDate(''); setNewTitle(''); setNewNote('')
        await fetchAnnotations()
      }
    } finally {
      setSavingAnnotation(false)
    }
  }

  async function handleDeleteAnnotation(id: string) {
    await fetch(`/api/admin/analytics/annotations?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
    await fetchAnnotations()
  }

  function startEdit(a: { id: string; occurred_on: string; title: string; note: string | null }) {
    setEditingId(a.id)
    setEditDate(a.occurred_on)
    setEditTitle(a.title)
    setEditNote(a.note ?? '')
  }

  async function handleSaveEdit(id: string) {
    await fetch('/api/admin/analytics/annotations', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, occurred_on: editDate, title: editTitle, note: editNote || null }),
    })
    setEditingId(null)
    await fetchAnnotations()
  }

  const annotationDates = annotationList.map(a => a.occurred_on)
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

  const reschedChartData = rescheduleTrend.weeks.map(w => ({
    week: formatWeekLabel(w.week),
    rescheduleRate: w.rescheduleRate !== null ? +(w.rescheduleRate * 100).toFixed(1) : null,
    partsRescheduleRate: w.partsRescheduleRate !== null ? +(w.partsRescheduleRate * 100).toFixed(1) : null,
  }))

  // Revenue trend — only keep every 7th label to avoid crowding
  const revTrendData = revenueTrend.map((d, i) => ({
    date: i % 14 === 0 ? formatDateLabel(d.date) : '',
    rawDate: d.date,
    revenue: d.revenue,
    rolling28: d.rolling28 !== null ? +d.rolling28.toFixed(0) : null,
  }))

  const jobsTrendData = jobsTrend.map((d, i) => ({
    date: i % 14 === 0 ? formatDateLabel(d.date) : '',
    rawDate: d.date,
    jobs: d.jobs,
    rolling28: d.rolling28 !== null ? +d.rolling28.toFixed(2) : null,
  }))

  const sortedAnnotations = [...annotationList].sort((a, b) => b.occurred_on.localeCompare(a.occurred_on))

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

              {/* Outstanding A/R */}
              <Card className="col-span-2 lg:col-span-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-gray-500 mb-1">Outstanding A/R</p>
                    <p className="text-2xl font-bold text-gray-900">{fmt$(snapshotMetrics.outstandingAR)}</p>
                  </div>
                </div>
              </Card>
            </div>
          </div>

          {/* Section 2 — Revenue & Job Volume Trend */}
          <div>
            <h2 className="text-sm font-semibold text-gray-700 mb-2">Revenue &amp; Job Volume (Last 90 Days)</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Revenue Chart */}
              <Card>
                <p className="text-xs font-medium text-gray-700 mb-2">Revenue per Day</p>
                <ChartLegend />
                <div className="h-52 mt-2">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={revTrendData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="date" tick={{ fontSize: 10 }} tickLine={false} />
                      <YAxis
                        tick={{ fontSize: 10 }}
                        tickFormatter={v => `$${(v / 1000).toFixed(0)}k`}
                        width={40}
                      />
                      <Tooltip
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        formatter={(value: any, name: any) => [
                          typeof value === 'number' ? fmt$(value) : value,
                          name === 'revenue' ? 'Revenue' : '28d Avg',
                        ]}
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        labelFormatter={(_: any, payload: readonly any[]) =>
                          (payload as any[])?.[0]?.payload?.rawDate ?? ''
                        }
                      />
                      {annotationDates.map(d => (
                        <ReferenceLine
                          key={d}
                          x={d}
                          stroke="#ef4444"
                          strokeDasharray="4 2"
                          label={{ value: '●', position: 'top', fontSize: 8, fill: '#ef4444' }}
                        />
                      ))}
                      <Line
                        type="monotone"
                        dataKey="revenue"
                        stroke="#dc2626"
                        strokeWidth={1.5}
                        dot={false}
                        connectNulls={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="rolling28"
                        stroke="#9ca3af"
                        strokeWidth={1.5}
                        strokeDasharray="5 3"
                        dot={false}
                        connectNulls={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </Card>

              {/* Jobs Chart */}
              <Card>
                <p className="text-xs font-medium text-gray-700 mb-2">Jobs Completed per Day</p>
                <ChartLegend />
                <div className="h-52 mt-2">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={jobsTrendData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="date" tick={{ fontSize: 10 }} tickLine={false} />
                      <YAxis tick={{ fontSize: 10 }} width={30} allowDecimals={false} />
                      <Tooltip
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        formatter={(value: any, name: any) => [
                          typeof value === 'number' ? value.toFixed(1) : value,
                          name === 'jobs' ? 'Jobs' : '28d Avg',
                        ]}
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        labelFormatter={(_: any, payload: readonly any[]) =>
                          (payload as any[])?.[0]?.payload?.rawDate ?? ''
                        }
                      />
                      {annotationDates.map(d => (
                        <ReferenceLine
                          key={d}
                          x={d}
                          stroke="#ef4444"
                          strokeDasharray="4 2"
                          label={{ value: '●', position: 'top', fontSize: 8, fill: '#ef4444' }}
                        />
                      ))}
                      <Line
                        type="monotone"
                        dataKey="jobs"
                        stroke="#dc2626"
                        strokeWidth={1.5}
                        dot={false}
                        connectNulls={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="rolling28"
                        stroke="#9ca3af"
                        strokeWidth={1.5}
                        strokeDasharray="5 3"
                        dot={false}
                        connectNulls={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </Card>
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

              {/* Reschedule rate */}
              <Card className="md:col-span-2">
                <p className="text-xs font-medium text-gray-700 mb-2">Reschedule Rate (Weekly)</p>
                <div className="h-44">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={reschedChartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="week" tick={{ fontSize: 10 }} tickLine={false} />
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
              </Card>

              {/* Scheduled backlog */}
              <Card>
                <p className="text-xs text-gray-500 mb-1">Scheduled Backlog (Next 7 Days)</p>
                <p className="text-2xl font-bold text-gray-900">{backlog.count}</p>
                <p className="text-xs text-gray-400 mt-1">jobs scheduled</p>
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

          {/* Section 7 — Pipeline */}
          <div>
            <h2 className="text-sm font-semibold text-gray-700 mb-2">Pipeline</h2>
            <div className="grid grid-cols-3 gap-3">
              <Card>
                <p className="text-xs text-gray-500 mb-1">Fresh (0–7d)</p>
                <p className="text-xl font-bold text-gray-900">{pipeline.buckets.fresh}</p>
                <p className="text-xs text-gray-400 mt-0.5">{fmt$(pipeline.buckets.freshValue)}</p>
              </Card>
              <Card>
                <p className="text-xs text-gray-500 mb-1">Aging (8–30d)</p>
                <p className="text-xl font-bold text-yellow-700">{pipeline.buckets.aging}</p>
                <p className="text-xs text-gray-400 mt-0.5">{fmt$(pipeline.buckets.agingValue)}</p>
              </Card>
              <Card>
                <p className="text-xs text-gray-500 mb-1">Old (30+d)</p>
                <p className="text-xl font-bold text-red-600">{pipeline.buckets.old}</p>
                <p className="text-xs text-gray-400 mt-0.5">{fmt$(pipeline.buckets.oldValue)}</p>
              </Card>
            </div>
            <p className="text-xs text-gray-400 mt-2">
              {pipeline.totalOpen} open estimates · {fmt$(pipeline.totalValue)} total value
            </p>
          </div>

          {/* Section 8 — Annotations Manager */}
          <div>
            <h2 className="text-sm font-semibold text-gray-700 mb-2">Annotations</h2>
            <Card>
              {/* Add annotation form */}
              <form onSubmit={handleAddAnnotation} className="flex flex-col sm:flex-row gap-2 mb-4">
                <input
                  type="date"
                  value={newDate}
                  onChange={e => setNewDate(e.target.value)}
                  required
                  className="border border-gray-300 rounded-md px-3 py-1.5 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-red-400"
                />
                <input
                  type="text"
                  value={newTitle}
                  onChange={e => setNewTitle(e.target.value)}
                  placeholder="Title"
                  required
                  className="flex-1 border border-gray-300 rounded-md px-3 py-1.5 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-red-400"
                />
                <input
                  type="text"
                  value={newNote}
                  onChange={e => setNewNote(e.target.value)}
                  placeholder="Note (optional)"
                  className="flex-1 border border-gray-300 rounded-md px-3 py-1.5 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-red-400"
                />
                <button
                  type="submit"
                  disabled={savingAnnotation}
                  className="text-sm bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded-md font-medium disabled:opacity-50 whitespace-nowrap"
                >
                  {savingAnnotation ? 'Saving…' : 'Add annotation'}
                </button>
              </form>

              {/* Annotations list */}
              {sortedAnnotations.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4">No annotations yet.</p>
              ) : (
                <div className="space-y-2">
                  {sortedAnnotations.map(a => (
                    <div key={a.id} className="flex items-start gap-3 py-2 border-b border-gray-100 last:border-0">
                      {editingId === a.id ? (
                        <div className="flex-1 flex flex-col sm:flex-row gap-2">
                          <input
                            type="date"
                            value={editDate}
                            onChange={e => setEditDate(e.target.value)}
                            className="border border-gray-300 rounded px-2 py-1 text-xs"
                          />
                          <input
                            type="text"
                            value={editTitle}
                            onChange={e => setEditTitle(e.target.value)}
                            className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs"
                          />
                          <input
                            type="text"
                            value={editNote}
                            onChange={e => setEditNote(e.target.value)}
                            placeholder="Note"
                            className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs"
                          />
                          <button
                            onClick={() => handleSaveEdit(a.id)}
                            className="text-xs bg-gray-900 text-white px-2 py-1 rounded font-medium"
                          >
                            Save
                          </button>
                          <button
                            onClick={() => setEditingId(null)}
                            className="text-xs text-gray-500 hover:text-gray-700"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <>
                          <span className="shrink-0 text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full font-medium">
                            {a.occurred_on}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-900">{a.title}</p>
                            {a.note && <p className="text-xs text-gray-500 mt-0.5">{a.note}</p>}
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              onClick={() => startEdit(a)}
                              className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => handleDeleteAnnotation(a.id)}
                              className="text-xs text-red-600 hover:text-red-800 font-medium"
                            >
                              Delete
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
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
