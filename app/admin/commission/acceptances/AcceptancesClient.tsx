'use client'

import { useEffect, useState } from 'react'

interface AcceptanceRow {
  id: string
  tech_name: string
  period_label: string
  accepted_name: string
  accepted_at: string
  ip: string | null
  legal_version: string
  sales_target: number | null
  rate_below: number | null
  rate_above: number | null
}

function fmtCurrency(n: number | null): string {
  if (n == null) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
}
function fmtPercent(r: number | null): string {
  if (r == null) return '—'
  const pct = r * 100
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2)}%`
}
function fmtDateTime(s: string): string {
  const d = new Date(s)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

export default function AcceptancesClient() {
  const [rows, setRows] = useState<AcceptanceRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/admin/commission/acceptances')
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Failed to load')
        setRows(data.items ?? [])
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <a
          href="/api/admin/commission/acceptances?format=csv"
          className="text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium px-3 py-1.5 rounded-md"
        >
          Download CSV
        </a>
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded px-4 py-2 text-sm text-red-600">{error}</div>}

      <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Technician</th>
              <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Period</th>
              <th className="px-4 py-2 text-right text-xs font-semibold text-gray-500 uppercase tracking-wide">Target</th>
              <th className="px-4 py-2 text-right text-xs font-semibold text-gray-500 uppercase tracking-wide">Below / Above</th>
              <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Signed</th>
              <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Accepted (PT)</th>
              <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">IP</th>
              <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Ver.</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-400">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-400">No acceptances recorded yet.</td></tr>
            ) : rows.map(r => (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="px-4 py-2 font-medium text-gray-900 whitespace-nowrap">{r.tech_name}</td>
                <td className="px-4 py-2 text-gray-600 whitespace-nowrap">{r.period_label}</td>
                <td className="px-4 py-2 text-right text-gray-600">{fmtCurrency(r.sales_target)}</td>
                <td className="px-4 py-2 text-right text-gray-600 whitespace-nowrap">{fmtPercent(r.rate_below)} / {fmtPercent(r.rate_above)}</td>
                <td className="px-4 py-2 text-gray-900">{r.accepted_name}</td>
                <td className="px-4 py-2 text-gray-600 whitespace-nowrap">{fmtDateTime(r.accepted_at)}</td>
                <td className="px-4 py-2 text-gray-400 whitespace-nowrap">{r.ip ?? '—'}</td>
                <td className="px-4 py-2 text-gray-400">{r.legal_version}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
