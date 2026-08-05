'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { formatMoney } from '@/lib/week'
import { listPeriods, periodForRecognitionDate } from '@/lib/commission/periods'

interface Row { tech_user_id: string; full_name: string; payable: number; paid_total: number; balance: number }

export default function PaymentsOverviewClient({ todayStr }: { todayStr: string }) {
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
      const res = await fetch(`/api/admin/commission/payments/overview?period_start=${period.start}&period_end=${period.end}`)
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

  const totals = rows.reduce((t, r) => ({ payable: t.payable + r.payable, paid: t.paid + r.paid_total, balance: t.balance + r.balance }), { payable: 0, paid: 0, balance: 0 })

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

      {error && <div className="bg-red-50 border border-red-200 rounded px-4 py-2 text-sm text-red-600">{error}</div>}

      {loading ? (
        <div className="text-center text-gray-400 py-10">Loading…</div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Technician</th>
                  <th className="text-right px-3 py-3 font-medium text-gray-600">Collected (owed)</th>
                  <th className="text-right px-3 py-3 font-medium text-gray-600">Paid</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.length === 0 ? (
                  <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-400">No technicians.</td></tr>
                ) : rows.map(r => (
                  <tr key={r.tech_user_id}>
                    <td className="px-4 py-2 text-gray-900">
                      <Link href={`/admin/commission/techs?tech=${r.tech_user_id}&period=${periodKey}`} className="hover:underline">{r.full_name}</Link>
                    </td>
                    <td className="px-3 py-2 text-right text-gray-700">{formatMoney(r.payable)}</td>
                    <td className="px-3 py-2 text-right text-gray-700">{formatMoney(r.paid_total)}</td>
                    <td className={`px-4 py-2 text-right font-medium ${r.balance > 0 ? 'text-amber-600' : r.balance < 0 ? 'text-green-700' : 'text-gray-500'}`}>
                      {r.balance < 0 ? `(${formatMoney(Math.abs(r.balance))})` : formatMoney(r.balance)}
                    </td>
                  </tr>
                ))}
              </tbody>
              {rows.length > 0 && (
                <tfoot>
                  <tr className="border-t border-gray-200 bg-gray-50 font-medium">
                    <td className="px-4 py-2 text-gray-700">Total</td>
                    <td className="px-3 py-2 text-right text-gray-700">{formatMoney(totals.payable)}</td>
                    <td className="px-3 py-2 text-right text-gray-700">{formatMoney(totals.paid)}</td>
                    <td className="px-4 py-2 text-right text-gray-900">{totals.balance < 0 ? `(${formatMoney(Math.abs(totals.balance))})` : formatMoney(totals.balance)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}
      <p className="text-xs text-gray-400">
        &ldquo;Collected (owed)&rdquo; is commission on jobs the customer has already paid — the amount safe to
        pay out now. A negative balance (in parentheses) means the tech was paid more than currently collected.
        Figures use the latest commission snapshot; hit Recompute if they look stale.
      </p>
    </div>
  )
}
