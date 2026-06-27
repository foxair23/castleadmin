'use client'

import { formatMoney } from '@/lib/week'
import type { TechPeriodDetail, Stage } from '@/lib/commission/detail'

const STAGE_ORDER: Stage[] = ['Sold', 'Completed', 'Invoiced', 'Paid']

function StageBadge({ stage }: { stage: Stage }) {
  const idx = STAGE_ORDER.indexOf(stage)
  const cls =
    stage === 'Paid' ? 'bg-green-100 text-green-700' :
    stage === 'Invoiced' ? 'bg-blue-100 text-blue-700' :
    stage === 'Completed' ? 'bg-amber-100 text-amber-700' :
    'bg-gray-100 text-gray-600'
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${cls}`} title={`Stage ${idx + 1} of 4`}>
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

export default function CommissionDetailPanel({ detail }: { detail: TechPeriodDetail }) {
  const s = detail.summary
  const target = s.sales_target ?? 0
  const pct = target > 0 ? Math.min(100, (s.eligible_revenue / target) * 100) : 0
  const overTarget = target > 0 && s.eligible_revenue > target

  return (
    <div className="space-y-6">
      {/* Progress vs target */}
      {s.has_plan ? (
        <div className="bg-white border border-gray-200 rounded-lg px-4 py-3">
          <div className="flex items-center justify-between text-sm mb-1.5">
            <span className="text-gray-600">Progress to target</span>
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
        </div>
      ) : (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-2 text-sm text-amber-800">
          No commission plan set for this period — no commission is earned until an admin configures one.
        </div>
      )}

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Eligible revenue" value={formatMoney(s.eligible_revenue)} />
        <Stat label="Commission earned" value={formatMoney(s.commission_earned)} />
        <Stat label="Payable now" value={formatMoney(s.commission_payable)} accent="green" sub="collected jobs + adjustments" />
        <Stat label="Pending collection" value={formatMoney(s.commission_pending)} accent="amber" sub="earned, not yet collected" />
      </div>

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

      {/* Job pipeline */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-2">
          Jobs this period <span className="text-gray-400 font-normal">({detail.jobs.length})</span>
        </h3>
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Customer</th>
                  <th className="text-left px-3 py-3 font-medium text-gray-600">Job #</th>
                  <th className="text-left px-3 py-3 font-medium text-gray-600">Completed</th>
                  <th className="text-right px-3 py-3 font-medium text-gray-600">Revenue</th>
                  <th className="text-center px-3 py-3 font-medium text-gray-600">Stage</th>
                  <th className="text-right px-3 py-3 font-medium text-gray-600">Commission</th>
                  <th className="text-left px-3 py-3 font-medium text-gray-600">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {detail.jobs.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-400">No completed jobs this period.</td></tr>
                ) : detail.jobs.map(j => (
                  <tr key={j.sf_job_id} className={j.status === 'not_accepted' ? 'opacity-50' : ''}>
                    <td className="px-4 py-2 text-gray-900">{j.customer_name ?? '—'}</td>
                    <td className="px-3 py-2 text-gray-600">{j.job_number ?? j.sf_job_id}</td>
                    <td className="px-3 py-2 text-gray-600">{j.recognition_date}</td>
                    <td className="px-3 py-2 text-right text-gray-700">{formatMoney(j.revenue)}</td>
                    <td className="px-3 py-2 text-center"><StageBadge stage={j.stage} /></td>
                    <td className="px-3 py-2 text-right text-gray-900 font-medium">
                      {j.status === 'not_accepted' ? '—' : formatMoney(j.commission)}
                      {j.status === 'eligible' && j.commission > 0 && (
                        <span className={`ml-2 text-xs ${j.payable ? 'text-green-600' : 'text-amber-600'}`}>
                          {j.payable ? 'payable' : 'pending'}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {j.status === 'not_accepted'
                        ? <span className="text-xs text-gray-500">Not accepted</span>
                        : <span className="text-xs text-gray-600">Eligible</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Open / in-progress jobs (sold, not yet completed) */}
      {detail.open_jobs.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 mb-2">
            Open / in progress <span className="text-gray-400 font-normal">({detail.open_jobs.length})</span>
          </h3>
          <p className="text-xs text-gray-400 mb-2">
            Sold but not yet completed — these don&rsquo;t count toward this period until they close.
          </p>
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Customer</th>
                    <th className="text-left px-3 py-3 font-medium text-gray-600">Job #</th>
                    <th className="text-left px-3 py-3 font-medium text-gray-600">Scheduled</th>
                    <th className="text-center px-3 py-3 font-medium text-gray-600">Stage</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {detail.open_jobs.map(j => (
                    <tr key={j.sf_job_id}>
                      <td className="px-4 py-2 text-gray-900">{j.customer_name ?? '—'}</td>
                      <td className="px-3 py-2 text-gray-600">{j.job_number ?? j.sf_job_id}</td>
                      <td className="px-3 py-2 text-gray-600">{j.start_date ?? '—'}</td>
                      <td className="px-3 py-2 text-center"><StageBadge stage={j.stage} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
