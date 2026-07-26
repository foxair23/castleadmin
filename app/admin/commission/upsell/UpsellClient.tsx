'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { listPeriods, periodForRecognitionDate } from '@/lib/commission/periods'

// Mirrors the shapes returned by lib/commission/upsell.ts
interface JobRow {
  sfJobId: string
  jobNumber: string | null
  customerName: string | null
  completedDate: string | null
  before: number | null
  after: number
  incremental: number | null
  pct: number | null
  status: string
}
interface TechRow {
  techKey: string
  techUserId: string | null
  techName: string
  jobs: number
  jobsWithBaseline: number
  before: number
  after: number
  incremental: number
  avgPct: number | null
}
interface Result {
  total: { incremental: number; before: number; after: number; jobs: number; jobsWithBaseline: number }
  techRows: TechRow[]
  jobsByTech: Record<string, JobRow[]>
}

function money(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}
function signedMoney(n: number): string {
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${money(Math.abs(n))}`
}
function pctLabel(p: number | null): string {
  if (p === null) return '—'
  const v = Math.round(p * 100)
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}%`
}
function deltaClass(n: number): string {
  return n > 0 ? 'text-green-600' : n < 0 ? 'text-red-600' : 'text-gray-500'
}
function fmtDate(d: string | null): string {
  if (!d) return '—'
  return new Date(d.slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function UpsellClient({ todayStr }: { todayStr: string }) {
  const periods = useMemo(() => listPeriods(todayStr).reverse(), [todayStr])
  const current = useMemo(() => periodForRecognitionDate(todayStr) ?? periods[0], [todayStr, periods])
  const [periodKey, setPeriodKey] = useState(current?.key ?? periods[0]?.key)
  const period = useMemo(() => periods.find(p => p.key === periodKey), [periods, periodKey])

  const [data, setData] = useState<Result | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedTech, setSelectedTech] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!period) { setLoading(false); return }
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/admin/commission/upsell?period_start=${period.start}&period_end=${period.end}`)
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
      setData(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [period])

  useEffect(() => { load() }, [load])
  useEffect(() => { setSelectedTech(null) }, [periodKey])

  const selectedRow = data?.techRows.find(t => t.techKey === selectedTech) ?? null
  const selectedJobs = selectedTech ? (data?.jobsByTech[selectedTech] ?? []) : []

  return (
    <div>
      {/* Period selector */}
      <div className="flex items-center gap-2 mb-4">
        <label className="text-sm text-gray-600">Period</label>
        <select
          value={periodKey}
          onChange={e => setPeriodKey(e.target.value)}
          className="text-sm border border-gray-300 rounded-md px-2 py-1.5 text-gray-900 bg-white"
        >
          {periods.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
      </div>

      {error && <div className="text-sm text-red-600 mb-4">{error}</div>}
      {loading && <div className="text-sm text-gray-400">Loading…</div>}

      {!loading && data && (
        <>
          {/* Headline */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            <div className="bg-white border border-gray-200 rounded-lg p-4 col-span-2 sm:col-span-1">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Incremental Revenue</p>
              <p className={`mt-1 text-2xl font-bold ${deltaClass(data.total.incremental)}`}>
                {signedMoney(data.total.incremental)}
              </p>
              <p className="text-xs text-gray-400 mt-0.5">net, this period</p>
            </div>
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Before → After</p>
              <p className="mt-1 text-sm font-semibold text-gray-900">{money(data.total.before)} → {money(data.total.after)}</p>
              <p className="text-xs text-gray-400 mt-0.5">over jobs with a baseline</p>
            </div>
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Jobs w/ baseline</p>
              <p className="mt-1 text-2xl font-bold text-gray-900">{data.total.jobsWithBaseline}<span className="text-sm text-gray-400"> / {data.total.jobs}</span></p>
            </div>
          </div>

          {/* Detail: a single tech's jobs */}
          {selectedTech ? (
            <div>
              <button
                onClick={() => setSelectedTech(null)}
                className="text-sm text-blue-600 hover:text-blue-800 mb-3"
              >
                ← All techs
              </button>
              <div className="flex items-baseline justify-between mb-2">
                <h2 className="text-base font-semibold text-gray-900">{selectedRow?.techName ?? 'Tech'}</h2>
                {selectedRow && (
                  <span className={`text-sm font-semibold ${deltaClass(selectedRow.incremental)}`}>
                    {signedMoney(selectedRow.incremental)} incremental
                  </span>
                )}
              </div>
              <JobTable jobs={selectedJobs} />
            </div>
          ) : (
            /* Overview: per-tech contribution */
            data.techRows.length === 0 ? (
              <p className="py-6 text-sm text-gray-400">No commission jobs this period yet.</p>
            ) : (
              <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                      <th className="px-4 py-2">Tech</th>
                      <th className="px-4 py-2 text-right">Jobs</th>
                      <th className="px-4 py-2 text-right">Before</th>
                      <th className="px-4 py-2 text-right">After</th>
                      <th className="px-4 py-2 text-right">Incremental</th>
                      <th className="px-4 py-2 text-right">Avg %</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {data.techRows.map(t => (
                      <tr
                        key={t.techKey}
                        onClick={() => setSelectedTech(t.techKey)}
                        className="cursor-pointer hover:bg-blue-50 transition-colors"
                      >
                        <td className="px-4 py-2 font-medium text-gray-900">{t.techName}</td>
                        <td className="px-4 py-2 text-right text-gray-600 tabular-nums">
                          {t.jobsWithBaseline}<span className="text-gray-400"> / {t.jobs}</span>
                        </td>
                        <td className="px-4 py-2 text-right text-gray-600 tabular-nums">{money(t.before)}</td>
                        <td className="px-4 py-2 text-right text-gray-600 tabular-nums">{money(t.after)}</td>
                        <td className={`px-4 py-2 text-right font-semibold tabular-nums ${deltaClass(t.incremental)}`}>{signedMoney(t.incremental)}</td>
                        <td className={`px-4 py-2 text-right tabular-nums ${t.avgPct === null ? 'text-gray-400' : deltaClass(t.avgPct)}`}>{pctLabel(t.avgPct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
        </>
      )}
    </div>
  )
}

function JobTable({ jobs }: { jobs: JobRow[] }) {
  if (jobs.length === 0) return <p className="py-6 text-sm text-gray-400">No jobs.</p>
  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
            <th className="px-4 py-2">Job #</th>
            <th className="px-4 py-2">Customer</th>
            <th className="px-4 py-2">Completed</th>
            <th className="px-4 py-2 text-right">Before</th>
            <th className="px-4 py-2 text-right">After</th>
            <th className="px-4 py-2 text-right">Δ $</th>
            <th className="px-4 py-2 text-right">Δ %</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {jobs.map(j => (
            <tr key={j.sfJobId}>
              <td className="px-4 py-2 font-medium text-gray-900 tabular-nums">{j.jobNumber ?? j.sfJobId}</td>
              <td className="px-4 py-2 text-gray-700">{j.customerName ?? '—'}</td>
              <td className="px-4 py-2 text-gray-500 whitespace-nowrap">{fmtDate(j.completedDate)}</td>
              <td className="px-4 py-2 text-right text-gray-600 tabular-nums">{j.before === null ? '—' : money(j.before)}</td>
              <td className="px-4 py-2 text-right text-gray-600 tabular-nums">{money(j.after)}</td>
              <td className={`px-4 py-2 text-right font-semibold tabular-nums ${j.incremental === null ? 'text-gray-400' : deltaClass(j.incremental)}`}>
                {j.incremental === null ? '—' : signedMoney(j.incremental)}
              </td>
              <td className={`px-4 py-2 text-right tabular-nums ${j.pct === null ? 'text-gray-400' : deltaClass(j.pct)}`}>
                {j.before !== null && j.pct === null ? 'new' : pctLabel(j.pct)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
