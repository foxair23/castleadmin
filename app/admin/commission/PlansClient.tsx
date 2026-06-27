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
  const [loading, setLoading] = useState(true)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [copying, setCopying] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const load = useCallback(async () => {
    if (!period) return
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
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [period])

  useEffect(() => { load() }, [load])

  function setDraft(techId: string, field: keyof Draft, value: string) {
    setDrafts(prev => ({ ...prev, [techId]: { ...prev[techId], [field]: value } }))
  }

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

  async function saveRow(row: PlanRow) {
    if (!period) return
    const d = drafts[row.tech_user_id]
    setSavingId(row.tech_user_id)
    setError('')
    setSuccess('')
    try {
      const blank = d.target === '' && d.below === '' && d.above === ''
      if (blank) {
        // Clearing the plan entirely.
        const res = await fetch(
          `/api/admin/commission/plans?tech_user_id=${row.tech_user_id}&period_start=${period.start}&period_end=${period.end}`,
          { method: 'DELETE' },
        )
        if (!res.ok) throw new Error((await res.json()).error || 'Failed to clear')
      } else {
        const res = await fetch('/api/admin/commission/plans', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'save',
            tech_user_id: row.tech_user_id,
            period_start: period.start,
            period_end: period.end,
            sales_target: d.target === '' ? 0 : parseFloat(d.target),
            rate_below: d.below === '' ? 0 : parseFloat(d.below) / 100,
            rate_above: d.above === '' ? 0 : parseFloat(d.above) / 100,
          }),
        })
        if (!res.ok) throw new Error((await res.json()).error || 'Failed to save')
      }
      setSuccess(`Saved ${row.full_name}`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSavingId(null)
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
            onChange={e => setPeriodKey(e.target.value)}
            className="border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-400"
          >
            {periods.map(p => (
              <option key={p.key} value={p.key}>{p.label}</option>
            ))}
          </select>
        </div>
        <button
          onClick={copyLastPeriod}
          disabled={copying}
          className="border border-gray-300 text-gray-600 rounded px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-60"
        >
          {copying ? 'Copying…' : 'Copy last period'}
        </button>
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
                <th className="px-3 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={8} className="px-4 py-6 text-center text-gray-400">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-6 text-center text-gray-400">No active technicians.</td></tr>
              ) : rows.map(row => {
                const d = drafts[row.tech_user_id] ?? { target: '', below: '', above: '' }
                const preview = previewCommission(row)
                return (
                  <tr key={row.tech_user_id}>
                    <td className="px-4 py-2 text-gray-900">{row.full_name}</td>
                    <td className="px-3 py-2 text-right text-gray-700">{formatMoney(row.eligible_revenue)}</td>
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
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => saveRow(row)}
                        disabled={savingId === row.tech_user_id}
                        className="text-red-600 hover:underline text-xs disabled:opacity-60"
                      >
                        {savingId === row.tech_user_id ? 'Saving…' : 'Save'}
                      </button>
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
