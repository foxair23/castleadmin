'use client'

interface WorkItem {
  name: string
  quantity: number
  calculated_pay: number
}

interface UnifiedRow {
  key: string
  date: string
  sfJobId: string | null
  sfJobNumber: string | null
  jobName: string | null
  revenue: number | null
  labor: number | null
  items: WorkItem[]
}

interface Props {
  techName: string
  weekStart: string
  weekEnd: string
  rows: UnifiedRow[]
  totalRevenue: number
  totalLabor: number | null
  hasPieceworkLink: boolean
}

const fmt$ = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)

function formatDate(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  })
}

function weekLabel(start: string, end: string): string {
  const s = new Date(start + 'T00:00:00')
  const e = new Date(end + 'T00:00:00')
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${fmt(s)} – ${fmt(e)}, ${e.getFullYear()}`
}

export default function TechDetailClient({
  techName,
  weekStart,
  weekEnd,
  rows,
  totalRevenue,
  totalLabor,
  hasPieceworkLink,
}: Props) {
  const profit = totalLabor !== null ? totalRevenue - totalLabor : null
  const marginPct = profit !== null && totalRevenue > 0 ? (profit / totalRevenue) * 100 : null

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-gray-900">{techName}</h1>
        <p className="text-sm text-gray-500 mt-0.5">{weekLabel(weekStart, weekEnd)}</p>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <p className="text-xs text-gray-500 mb-1">Jobs</p>
          <p className="text-2xl font-bold text-gray-900">{rows.filter(r => r.revenue !== null).length}</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <p className="text-xs text-gray-500 mb-1">Revenue</p>
          <p className="text-2xl font-bold text-gray-900">{fmt$(totalRevenue)}</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <p className="text-xs text-gray-500 mb-1">Labor</p>
          {totalLabor !== null
            ? <p className="text-2xl font-bold text-gray-900">{fmt$(totalLabor)}</p>
            : <p className="text-2xl font-bold text-gray-400">—</p>}
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <p className="text-xs text-gray-500 mb-1">Margin</p>
          {marginPct !== null
            ? <p className={`text-2xl font-bold ${marginPct >= 40 ? 'text-green-700' : marginPct >= 20 ? 'text-yellow-700' : 'text-red-600'}`}>
                {marginPct.toFixed(1)}%
              </p>
            : <p className="text-2xl font-bold text-gray-400">—</p>}
          {profit !== null && (
            <p className="text-xs text-gray-400 mt-0.5">{profit >= 0 ? '+' : ''}{fmt$(profit)} profit</p>
          )}
        </div>
      </div>

      {/* Unified job table */}
      <div>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">Jobs This Week</h2>
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          {rows.length === 0 ? (
            <p className="text-sm text-gray-400 py-6 text-center">No jobs this week.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left py-2 px-4 text-xs font-medium text-gray-500">Date</th>
                  <th className="text-left py-2 px-4 text-xs font-medium text-gray-500">Job</th>
                  <th className="text-right py-2 px-4 text-xs font-medium text-gray-500">Revenue</th>
                  <th className="text-right py-2 px-4 text-xs font-medium text-gray-500">Labor</th>
                  <th className="text-right py-2 px-4 text-xs font-medium text-gray-500">Profit</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => {
                  const rowProfit = row.revenue !== null && row.labor !== null
                    ? row.revenue - row.labor
                    : null
                  return (
                    <>
                      <tr key={row.key} className="border-t border-gray-100 hover:bg-gray-50">
                        <td className="py-2.5 px-4 text-gray-600 whitespace-nowrap">{formatDate(row.date)}</td>
                        <td className="py-2.5 px-4">
                          {row.jobName && (
                            <span className="text-gray-900 font-medium">{row.jobName}</span>
                          )}
                          {row.sfJobNumber ? (
                            <span className="block text-xs text-gray-400 font-mono">SF #{row.sfJobNumber}</span>
                          ) : row.sfJobId ? (
                            <span className="block text-xs text-gray-400 font-mono">{row.sfJobId}</span>
                          ) : null}
                          {!row.jobName && !row.sfJobId && !row.sfJobNumber && (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="py-2.5 px-4 text-right font-medium text-gray-900">
                          {row.revenue !== null ? fmt$(row.revenue) : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="py-2.5 px-4 text-right text-gray-600">
                          {row.labor !== null ? fmt$(row.labor) : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="py-2.5 px-4 text-right font-medium">
                          {rowProfit !== null
                            ? <span className={rowProfit >= 0 ? 'text-green-700' : 'text-red-600'}>{fmt$(rowProfit)}</span>
                            : <span className="text-gray-300">—</span>}
                        </td>
                      </tr>
                      {row.items.length > 0 && (
                        <tr key={`${row.key}-items`} className="bg-gray-50 border-t border-gray-100">
                          <td />
                          <td colSpan={4} className="px-4 py-1.5">
                            <div className="space-y-0.5">
                              {row.items.map((item, i) => (
                                <div key={i} className="flex justify-between text-xs text-gray-500">
                                  <span className="pl-3">{item.name}{item.quantity > 1 ? ` ×${item.quantity}` : ''}</span>
                                  <span>{fmt$(item.calculated_pay)}</span>
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  )
                })}
              </tbody>
              <tfoot className="border-t-2 border-gray-200 bg-gray-50">
                <tr>
                  <td colSpan={2} className="py-2.5 px-4 text-xs font-semibold text-gray-600">Total</td>
                  <td className="py-2.5 px-4 text-right text-sm font-bold text-gray-900">{fmt$(totalRevenue)}</td>
                  <td className="py-2.5 px-4 text-right text-sm font-bold text-gray-900">
                    {totalLabor !== null ? fmt$(totalLabor) : <span className="text-gray-400">—</span>}
                  </td>
                  <td className="py-2.5 px-4 text-right text-sm font-bold">
                    {profit !== null
                      ? <span className={profit >= 0 ? 'text-green-700' : 'text-red-600'}>{fmt$(profit)}</span>
                      : <span className="text-gray-400">—</span>}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}

          {!hasPieceworkLink && (
            <p className="text-xs text-gray-400 px-4 py-3 border-t border-gray-100">
              Labor columns are empty — set this tech&apos;s <code className="bg-gray-100 px-1 rounded">sf_technician_id</code> in Supabase to enable piecework tracking.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
