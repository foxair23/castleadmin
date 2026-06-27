'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { formatMoney } from '@/lib/week'
import { commissionOnRevenue } from '@/lib/commission/calc'
import { listPeriods, periodForRecognitionDate, type Period } from '@/lib/commission/periods'

interface PlanRow {
  tech_user_id: string
  full_name: string
  eligible_revenue: number
  collected_revenue: number
  sales_target: number | null
  rate_below: number | null
  rate_above: number | null
}

// Editable draft per row — rates held as percent strings for the inputs.
interface Draft {
  target: string
  below: string
  above: string
}

export default function PlansClient({ todayStr }: { todayStr: string }) {
  const periods = useMemo(() => listPeriods(todayStr).reverse(), [todayStr])
  const current = useMemo(() => periodForRecognitionDate(todayStr) ?? periods[0], [todayStr, periods])
  const [periodKey, setPeriodKey] = useState(current?.key ?? periods[0]?.key)

  const period: Period | undefined = useMemo(
    () => periods.find(p => p.key === periodKey),
    [periods, periodKey],
  )

  const [rows, setRows] = useState<PlanRow[]>([])
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  // Snapshot of drafts as loaded, to detect which rows changed.
  const [baseline, setBaseline] = useState<Record<string, Draft>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [copying, setCopying] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const load = useCallback(async () => {
    if (!period) { setLoading(false); return }
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/admin/commission/plans?period_start=${period.start}&period_end=${period.end}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load')
      const loaded: PlanRow[] = data.rows
      setRows(loaded)
      const d: Record<string, Draft> = {}
      for (const r of loaded) {
        d[r.tech_user_id] = {
          target: r.sales_target != null ? String(r.sales_target) : '',
          below: r.rate_below != null ? String(r.rate_below * 100) : '',
          above: r.rate_above != null ? String(r.rate_above * 100) : '',
        }
      }
      setDrafts(d)
      setBaseline(structuredClone(d))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [period])

  useEffect(() => { load() }, [load])

  function setDraft(techId: string, field: keyof Draft, value: string) {
    setDrafts(prev => ({ ...prev, [techId]: { ...prev[techId], [field]: value } }))
    setSuccess('')
  }

  function isDirty(techId: string): boolean {
    const d = drafts[techId], b = baseline[techId]
    if (!d || !b) return false
    return d.target !== b.target || d.below !== b.below || d.above !== b.above
  }

  const dirtyIds = rows.map(r => r.tech_user_id).filter(isDirty)

  // Live commission preview from the draft rates (§6).
  function previewCommission(row: PlanRow): number | null {
    const d = drafts[row.tech_user_id]
    if (!d || d.target === '' || d.below === '' || d.above === '') return null
    const target = parseFloat(d.target)
    const below = parseFloat(d.below) / 100
    const above = parseFloat(d.above) / 100
    if ([target, below, above].some(n => isNaN(n))) return null
    return commissionOnRevenue(row.eligible_revenue, { sales_target: target, rate_below: below, rate_above: above })
  }

  async function saveAll() {
    if (!period || dirtyIds.length === 0) return
    setSaving(true)
    setError('')
    setSuccess('')

    // A changed row with all three fields blank clears the plan; otherwise it's
    // an upsert. (Blank fields default to 0 within a partially-filled row.)
    const toSave: Array<{ tech_user_id: string; sales_target: number; rate_below: number; rate_above: number }> = []
    const toClear: string[] = []
    for (const techId of dirtyIds) {
      const d = drafts[techId]
      const blank = d.target === '' && d.below === '' && d.above === ''
      if (blank) {
        toClear.push(techId)
      } else {
        toSave.push({
          tech_user_id: techId,
          sales_target: d.target === '' ? 0 : parseFloat(d.target),
          rate_below: d.below === '' ? 0 : parseFloat(d.below) / 100,
          rate_above: d.above === '' ? 0 : parseFloat(d.above) / 100,
        })
      }
    }

    try {
      const res = await fetch('/api/admin/commission/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'bulk',
          period_start: period.start,
          period_end: period.end,
          rows: toSave,
          clears: toClear,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to save')
      setSuccess(`Saved ${dirtyIds.length} change${dirtyIds.length === 1 ? '' : 's'}`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function copyLastPeriod() {
    if (!period) return
    const idx = periods.findIndex(p => p.key === period.key)
    const prev = periods[idx + 1] // periods are newest-first
    if (!prev) { setError('No earlier period to copy from'); return }
    setCopying(true)
    setError('')
    setSuccess('')
    try {
      const res = await fetch('/api/admin/commission/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'copy',
          from_start: prev.start, from_end: prev.end,
          period_start: period.start, period_end: period.end,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to copy')
      setSuccess(`Copied ${data.copied} plan(s) from ${prev.label}`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to copy')
    } finally {
      setCopying(false)
    }
  }

  const inputCls = 'border border-gray-300 rounded px-2 py-1 text-sm text-gray-900 w-24 focus:outline-none focus:ring-2 focus:ring-red-400'

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600">Period</label>
          <select
            value={periodKey}
            onChange={e => {
              if (dirtyIds.length > 0 && !confirm('Discard unsaved changes and switch period?')) return
              setPeriodKey(e.target.value)
            }}
            className="border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-400"
          >
            {periods.map(p => (
              <option key={p.key} value={p.key}>{p.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-3">
          {dirtyIds.length > 0 && (
            <span className="text-xs text-amber-600">
              {dirtyIds.length} unsaved change{dirtyIds.length === 1 ? '' : 's'}
            </span>
          )}
          <button
            onClick={copyLastPeriod}
            disabled={copying || saving}
            className="border border-gray-300 text-gray-600 rounded px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-60"
          >
            {copying ? 'Copying…' : 'Copy last period'}
          </button>
          <button
            onClick={saveAll}
            disabled={saving || dirtyIds.length === 0}
            className="bg-red-600 text-white rounded px-4 py-1.5 text-sm font-medium hover:bg-red-700 disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>

      {success && (
        <div className="bg-green-50 border border-green-200 rounded px-4 py-2 text-sm text-green-800">{success}</div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded px-4 py-2 text-sm text-red-600">{error}</div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-3 font-medium text-gray-600">Technician</th>
                <th className="text-right px-3 py-3 font-medium text-gray-600">Eligible Rev</th>
                <th className="text-right px-3 py-3 font-medium text-gray-600">Collected</th>
                <th className="text-right px-3 py-3 font-medium text-gray-600">Target</th>
                <th className="text-right px-3 py-3 font-medium text-gray-600">Rate ≤ (%)</th>
                <th className="text-right px-3 py-3 font-medium text-gray-600">Rate &gt; (%)</th>
                <th className="text-right px-3 py-3 font-medium text-gray-600">Commission</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-400">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-400">No active technicians.</td></tr>
              ) : rows.map(row => {
                const d = drafts[row.tech_user_id] ?? { target: '', below: '', above: '' }
                const preview = previewCommission(row)
                return (
                  <tr key={row.tech_user_id} className={isDirty(row.tech_user_id) ? 'bg-amber-50' : ''}>
                    <td className="px-4 py-2 text-gray-900">{row.full_name}</td>
                    <td className="px-3 py-2 text-right">
                      <a
                        href={`/admin/commission/techs?tech=${row.tech_user_id}&period=${period?.key ?? ''}`}
                        className="text-red-600 hover:underline"
                        title="See the jobs that make up this revenue"
                      >
                        {formatMoney(row.eligible_revenue)}
                      </a>
                    </td>
                    <td className="px-3 py-2 text-right text-gray-500">{formatMoney(row.collected_revenue)}</td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number" inputMode="decimal" value={d.target}
                        onChange={e => setDraft(row.tech_user_id, 'target', e.target.value)}
                        className={inputCls} placeholder="—"
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number" inputMode="decimal" step="0.1" value={d.below}
                        onChange={e => setDraft(row.tech_user_id, 'below', e.target.value)}
                        className={inputCls} placeholder="—"
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number" inputMode="decimal" step="0.1" value={d.above}
                        onChange={e => setDraft(row.tech_user_id, 'above', e.target.value)}
                        className={inputCls} placeholder="—"
                      />
                    </td>
                    <td className="px-3 py-2 text-right text-gray-900 font-medium">
                      {preview != null ? formatMoney(preview) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs text-gray-400">
        Blank fields mean no plan for that technician this period (they earn nothing until a plan exists).
        Commission shown is the formula result on eligible revenue recognized so far; it updates as collection
        and new jobs come in.
      </p>
    </div>
  )
}
