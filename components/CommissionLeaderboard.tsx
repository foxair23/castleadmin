'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { formatMoney } from '@/lib/week'
import { listPeriods, periodForRecognitionDate } from '@/lib/commission/periods'

interface Row {
  rank: number
  tech_name: string
  dollars_sold: number
  dollars_received: number
}

// Sales leaderboard (TRD §9). Visible to all techs + admins. Shows only dollars
// sold and dollars received — no rates, targets, or commission.
export default function CommissionLeaderboard({
  todayStr,
  highlightName,
}: {
  todayStr: string
  highlightName?: string
}) {
  const periods = useMemo(() => listPeriods(todayStr).reverse(), [todayStr])
  const current = useMemo(() => periodForRecognitionDate(todayStr) ?? periods[0], [todayStr, periods])
  const [periodKey, setPeriodKey] = useState(current?.key ?? periods[0]?.key)
  const period = useMemo(() => periods.find(p => p.key === periodKey), [periods, periodKey])

  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!period) { setLoading(false); return }
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/commission/leaderboard?period_start=${period.start}&period_end=${period.end}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load')
      setRows(data.rows)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [period])

  useEffect(() => { load() }, [load])

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <label className="text-sm text-gray-600">Period</label>
        <select
          value={periodKey}
          onChange={e => setPeriodKey(e.target.value)}
          className="border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-400"
        >
          {periods.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded px-4 py-2 text-sm text-red-600">{error}</div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-3 font-medium text-gray-600 w-12">#</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Technician</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Dollars Sold</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Dollars Received</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-400">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-400">No sales this period yet.</td></tr>
              ) : rows.map(r => {
                const mine = highlightName && r.tech_name === highlightName
                return (
                  <tr key={r.rank} className={mine ? 'bg-red-50' : ''}>
                    <td className="px-4 py-2 text-gray-500 font-medium">{r.rank}</td>
                    <td className="px-4 py-2 text-gray-900 font-medium">
                      {r.tech_name}{mine && <span className="ml-2 text-xs text-red-500">you</span>}
                    </td>
                    <td className="px-4 py-2 text-right text-gray-900 font-semibold">{formatMoney(r.dollars_sold)}</td>
                    <td className="px-4 py-2 text-right text-gray-600">{formatMoney(r.dollars_received)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
      <p className="text-xs text-gray-400">
        Dollars sold = new business sold this period (by job date). Dollars received = of those, paid by the
        customer. This is a sales board — independent of commission, so it counts every sale regardless of
        completion or commission status.
      </p>
    </div>
  )
}
