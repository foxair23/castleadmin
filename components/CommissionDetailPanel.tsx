'use client'

import { formatMoney } from '@/lib/week'
import type { TechPeriodDetail, Stage } from '@/lib/commission/detail'

function StageBadge({ stage }: { stage: Stage }) {
  const cls =
    stage === 'Payment Received' ? 'bg-green-100 text-green-700' :
    stage === 'Invoiced' ? 'bg-blue-100 text-blue-700' :
    stage === 'Completed' ? 'bg-amber-100 text-amber-700' :
    'bg-gray-100 text-gray-600' // Scheduled
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {stage}
    </span>
  )
}

function Stat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: 'green' | 'amber' }) {
  const valueCls = accent === 'green' ? 'text-green-700' : accent === 'amber' ? 'text-amber-600' : 'text-gray-900'
  return (
    <div className="bg-white border border-gray-200 rounded-lg px-4 py-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-xl font-bold ${valueCls}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  )
}

// Cumulative pipeline buckets. Each job sits at one stage; a bucket includes
// every job that has reached that stage or beyond.
const STAGE_RANK: Record<Stage, number> = {
  'Scheduled': 0, 'Completed': 1, 'Invoiced': 2, 'Payment Received': 3,
}
const BUCKETS: { label: string; minRank: number; accent?: 'green' }[] = [
  { label: 'Job Sold', minRank: 0 },
  { label: 'Job Completed', minRank: 1 },
  { label: 'Job Invoiced', minRank: 2 },
  { label: 'Payment Received', minRank: 3, accent: 'green' },
]

export default function CommissionDetailPanel({ detail }: { detail: TechPeriodDetail }) {
  const s = detail.summary
  const target = s.sales_target ?? 0
  const pct = target > 0 ? Math.min(100, (s.eligible_revenue / target) * 100) : 0
  const overTarget = target > 0 && s.eligible_revenue > target

  const buckets = BUCKETS.map(b => {
    const jobs = detail.jobs.filter(j => STAGE_RANK[j.stage] >= b.minRank)
    return {
      label: b.label,
      accent: b.accent,
      count: jobs.length,
      revenue: jobs.reduce((sum, j) => sum + j.revenue, 0),
      commission: jobs.reduce((sum, j) => sum + j.commission, 0),
    }
  })

  return (
    <div className="space-y-6">
      {/* Progress vs target (on completed/recognized revenue) */}
      {s.has_plan ? (
        <div className="bg-white border border-gray-200 rounded-lg px-4 py-3">
          <div className="flex items-center justify-between text-sm mb-1.5">
            <span className="text-gray-600">Progress to target (completed work)</span>
            <span className="text-gray-900 font-medium">
              {formatMoney(s.eligible_revenue)} of {formatMoney(target)}
            </span>
          </div>
          <div className="h-2.5 w-full bg-gray-100 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${overTarget ? 'bg-green-500' : 'bg-red-500'}`}
              style={{ width: `${Math.max(2, pct)}%` }}
            />
          </div>
          {overTarget && (
            <div className="text-xs text-green-700 mt-1">
              {formatMoney(s.eligible_revenue - target)} into the higher tier
            </div>
          )}
          {s.scheduled_revenue > 0 && (
            <div className="text-xs text-gray-400 mt-1">
              + {formatMoney(s.scheduled_revenue)} scheduled (not yet completed)
            </div>
          )}
        </div>
      ) : (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-2 text-sm text-amber-800">
          No commission plan set for this period — no commission is earned until an admin configures one.
        </div>
      )}

      {/* Pipeline funnel — commission at each stage. "Sold" is every job with
          the agent listed; each later bucket is the subset that's progressed
          that far. Payment Received is the actual payout. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {buckets.map(b => (
          <Stat
            key={b.label}
            label={b.label}
            value={formatMoney(b.commission)}
            accent={b.accent}
            sub={`${b.count} job${b.count === 1 ? '' : 's'} · ${formatMoney(b.revenue)}`}
          />
        ))}
      </div>
      <p className="text-xs text-gray-400 -mt-3">
        Commission is only paid out once Castle receives the customer&rsquo;s payment. Earlier stages are
        estimates of what&rsquo;s coming.
      </p>

      {/* Adjustments */}
      {detail.adjustments.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 mb-2">Adjustments</h3>
          <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
            {detail.adjustments.map((a, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-2 text-sm">
                <span className="text-gray-600">{a.note}</span>
                <span className={a.amount < 0 ? 'text-red-600' : 'text-green-700'}>
                  {a.amount < 0 ? '−' : '+'}{formatMoney(Math.abs(a.amount))}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Unified job pipeline */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-2">
          Jobs <span className="text-gray-400 font-normal">({detail.jobs.length})</span>
        </h3>
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Customer</th>
                  <th className="text-left px-3 py-3 font-medium text-gray-600">Job #</th>
                  <th className="text-left px-3 py-3 font-medium text-gray-600">Date</th>
                  <th className="text-right px-3 py-3 font-medium text-gray-600">Revenue</th>
                  <th className="text-center px-3 py-3 font-medium text-gray-600">Status</th>
                  <th className="text-right px-3 py-3 font-medium text-gray-600">Commission</th>
                  <th className="text-left px-3 py-3 font-medium text-gray-600">Payment</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {detail.jobs.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-400">No jobs this period.</td></tr>
                ) : detail.jobs.map(j => (
                  <tr key={j.sf_job_id}>
                    <td className="px-4 py-2 text-gray-900">{j.customer_name ?? '—'}</td>
                    <td className="px-3 py-2 text-gray-600">{j.job_number ?? j.sf_job_id}</td>
                    <td className="px-3 py-2 text-gray-600">{j.date ?? '—'}</td>
                    <td className="px-3 py-2 text-right text-gray-700">{formatMoney(j.revenue)}</td>
                    <td className="px-3 py-2 text-center"><StageBadge stage={j.stage} /></td>
                    <td className="px-3 py-2 text-right text-gray-900 font-medium">
                      {formatMoney(j.commission)}
                      {j.projected && <span className="ml-1 text-xs text-gray-400">(est.)</span>}
                    </td>
                    <td className="px-3 py-2">
                      {j.received
                        ? <span className="text-xs text-green-600">Received</span>
                        : <span className="text-xs text-amber-600">Payment pending</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <p className="text-xs text-gray-400 mt-2">
          Commission is paid out when the company receives payment. Scheduled jobs show an estimated
          commission based on the quoted amount.
        </p>
      </div>
    </div>
  )
}
