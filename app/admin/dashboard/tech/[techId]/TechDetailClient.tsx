'use client'

interface SfJob {
  id: string
  total_amount: number | null
  completed_at: string | null
}

interface PieceworkItem {
  name: string
  quantity: number
  calculated_pay: number
}

interface PieceworkJob {
  id: string
  job_name: string
  work_date: string
  total_pay: number
  items: PieceworkItem[]
}

interface Props {
  techId: string
  techName: string
  weekStart: string
  weekEnd: string
  sfJobs: SfJob[]
  pieceworkJobs: PieceworkJob[]
  totalRevenue: number
  totalLabor: number | null
}

const fmt$ = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)

function formatDate(iso: string): string {
  return new Date(iso.slice(0, 10) + 'T00:00:00').toLocaleDateString('en-US', {
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
  sfJobs,
  pieceworkJobs,
  totalRevenue,
  totalLabor,
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
          <p className="text-xs text-gray-500 mb-1">SF Jobs</p>
          <p className="text-2xl font-bold text-gray-900">{sfJobs.length}</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <p className="text-xs text-gray-500 mb-1">Revenue</p>
          <p className="text-2xl font-bold text-gray-900">{fmt$(totalRevenue)}</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <p className="text-xs text-gray-500 mb-1">Labor</p>
          {totalLabor !== null ? (
            <p className="text-2xl font-bold text-gray-900">{fmt$(totalLabor)}</p>
          ) : (
            <p className="text-2xl font-bold text-gray-400">—</p>
          )}
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <p className="text-xs text-gray-500 mb-1">Margin</p>
          {marginPct !== null ? (
            <p className={`text-2xl font-bold ${
              marginPct >= 40 ? 'text-green-700' :
              marginPct >= 20 ? 'text-yellow-700' :
              'text-red-600'
            }`}>
              {marginPct.toFixed(1)}%
            </p>
          ) : (
            <p className="text-2xl font-bold text-gray-400">—</p>
          )}
          {profit !== null && (
            <p className="text-xs text-gray-400 mt-0.5">
              {profit >= 0 ? '+' : ''}{fmt$(profit)} profit
            </p>
          )}
        </div>
      </div>

      {/* SF Jobs table */}
      <div>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">Service Fusion Jobs</h2>
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          {sfJobs.length === 0 ? (
            <p className="text-sm text-gray-400 py-6 text-center">No completed SF jobs this week.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left py-2 px-4 text-xs font-medium text-gray-500">Job ID</th>
                  <th className="text-left py-2 px-4 text-xs font-medium text-gray-500">Completed</th>
                  <th className="text-right py-2 px-4 text-xs font-medium text-gray-500">Revenue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sfJobs.map(job => (
                  <tr key={job.id} className="hover:bg-gray-50">
                    <td className="py-2.5 px-4 font-mono text-xs text-gray-600">{job.id}</td>
                    <td className="py-2.5 px-4 text-gray-700">
                      {job.completed_at ? formatDate(job.completed_at) : '—'}
                    </td>
                    <td className="py-2.5 px-4 text-right font-medium text-gray-900">
                      {job.total_amount != null ? fmt$(job.total_amount) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-gray-200 bg-gray-50">
                <tr>
                  <td colSpan={2} className="py-2 px-4 text-xs font-semibold text-gray-600">Total</td>
                  <td className="py-2 px-4 text-right text-sm font-bold text-gray-900">{fmt$(totalRevenue)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>

      {/* Piecework Jobs */}
      <div>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">Piecework Submitted</h2>
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          {pieceworkJobs.length === 0 ? (
            <p className="text-sm text-gray-400 py-6 text-center">
              No piecework submitted for this week.
              {totalLabor === null && (
                <span className="block text-xs text-gray-400 mt-1">
                  Link this tech&apos;s profile to their SF technician ID to enable labor tracking.
                </span>
              )}
            </p>
          ) : (
            <div className="divide-y divide-gray-100">
              {pieceworkJobs.map(job => (
                <div key={job.id} className="px-4 py-3">
                  <div className="flex items-center justify-between mb-1">
                    <div>
                      <span className="text-sm font-medium text-gray-900">{job.job_name}</span>
                      <span className="text-xs text-gray-400 ml-2">{formatDate(job.work_date)}</span>
                    </div>
                    <span className="text-sm font-bold text-gray-900">{fmt$(job.total_pay)}</span>
                  </div>
                  {job.items.length > 0 && (
                    <div className="mt-1 space-y-0.5">
                      {job.items.map((item, i) => (
                        <div key={i} className="flex items-center justify-between text-xs text-gray-500 pl-3">
                          <span>{item.name}{item.quantity > 1 ? ` ×${item.quantity}` : ''}</span>
                          <span>{fmt$(item.calculated_pay)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              <div className="px-4 py-2.5 bg-gray-50 flex items-center justify-between border-t border-gray-200">
                <span className="text-xs font-semibold text-gray-600">Total labor</span>
                <span className="text-sm font-bold text-gray-900">
                  {totalLabor !== null ? fmt$(totalLabor) : '—'}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
