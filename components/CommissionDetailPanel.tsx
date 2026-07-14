'use client'

import { useState } from 'react'
import { formatMoney } from '@/lib/week'
import type { TechPeriodDetail, Stage } from '@/lib/commission/detail'

function StageBadge({ stage }: { stage: Stage }) {
  const cls =
    stage === 'Payment Received' ? 'bg-green-100 text-green-700' :
    stage === 'Invoiced' ? 'bg-blue-100 text-blue-700' :
    stage === 'Completed' ? 'bg-amber-100 text-amber-700' :
    stage === 'Scheduled' ? 'bg-purple-100 text-purple-700' :
    'bg-gray-100 text-gray-600' // Sold
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

const BUCKETS: { label: string; stage: Stage; accent?: 'green' }[] = [
  { label: 'Job Sold', stage: 'Sold' },
  { label: 'Job Scheduled', stage: 'Scheduled' },
  { label: 'Job Completed', stage: 'Completed' },
  { label: 'Job Invoiced', stage: 'Invoiced' },
  { label: 'Payment Received', stage: 'Payment Received', accent: 'green' },
]

export interface AdminControls {
  techUserId: string
  periodStart: string
  periodEnd: string
  /** Re-fetch the detail after a change. */
  onChanged: () => void
}

export default function CommissionDetailPanel({
  detail,
  admin,
}: {
  detail: TechPeriodDetail
  admin?: AdminControls
}) {
  const s = detail.summary
  const target = s.sales_target ?? 0
  const progressRevenue = s.received_revenue
  const pct = target > 0 ? Math.min(100, (progressRevenue / target) * 100) : 0
  const overTarget = target > 0 && progressRevenue > target

  // Buckets reflect commission-eligible pipeline → denied jobs excluded.
  const buckets = BUCKETS.map(b => {
    const jobs = detail.jobs.filter(j => j.stage === b.stage && j.accepted)
    return {
      label: b.label,
      accent: b.accent,
      count: jobs.length,
      revenue: jobs.reduce((sum, j) => sum + j.revenue, 0),
    }
  })

  const [busyJob, setBusyJob] = useState<string | null>(null)
  const [error, setError] = useState('')

  async function toggleEligibility(sfJobId: string, accepted: boolean) {
    if (!admin) return
    setBusyJob(sfJobId)
    setError('')
    try {
      const res = await fetch('/api/admin/commission/eligibility', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sf_job_id: sfJobId, accepted, tech_user_id: admin.techUserId }),
      })
      if (!res.ok) throw new Error((await res.json()).error || 'Failed')
      admin.onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setBusyJob(null)
    }
  }

  const colSpan = admin ? 8 : 7

  return (
    <div className="space-y-6">
      {/* Progress vs target (on received revenue) */}
      {s.has_plan ? (
        <div className="bg-white border border-gray-200 rounded-lg px-4 py-3">
          <div className="flex items-center justify-between text-sm mb-1.5">
            <span className="text-gray-600">Progress to target (payment received)</span>
            <span className="text-gray-900 font-medium">
              {formatMoney(progressRevenue)} of {formatMoney(target)}
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
              {formatMoney(progressRevenue - target)} into the higher tier
            </div>
          )}
        </div>
      ) : (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-2 text-sm text-amber-800">
          No commission plan set for this period — no commission is earned until an admin configures one.
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded px-4 py-2 text-sm text-red-600">{error}</div>
      )}

      {/* Pipeline chevrons — a job sits in exactly ONE stage and moves left→right
          as it progresses, so the arrows read as a flow, not five separate piles. */}
      <div>
        <div className="flex gap-[3px] overflow-x-auto pb-1">
          {buckets.map((b, i) => {
            const active = b.count > 0
            const isFirst = i === 0
            const isLast = i === buckets.length - 1
            const clip = isFirst
              ? 'polygon(0 0, calc(100% - 14px) 0, 100% 50%, calc(100% - 14px) 100%, 0 100%)'
              : isLast
              ? 'polygon(0 0, 100% 0, 100% 100%, 0 100%, 14px 50%)'
              : 'polygon(0 0, calc(100% - 14px) 0, 100% 50%, calc(100% - 14px) 100%, 0 100%, 14px 50%)'
            const cls = active
              ? b.accent === 'green'
                ? 'bg-green-600 text-white'
                : 'bg-red-600 text-white'
              : 'bg-gray-100 text-gray-400'
            return (
              <div
                key={b.label}
                className={`flex-1 min-w-[140px] px-5 py-3 ${cls}`}
                style={{ clipPath: clip }}
              >
                <div className={`text-xs whitespace-nowrap ${active ? 'text-white/90' : ''}`}>{b.label}</div>
                <div className="text-lg font-bold whitespace-nowrap">{formatMoney(b.revenue)}</div>
                <div className={`text-xs whitespace-nowrap ${active ? 'text-white/80' : ''}`}>{b.count} job{b.count === 1 ? '' : 's'}</div>
              </div>
            )
          })}
        </div>
        <p className="text-xs text-gray-400 mt-2">
          A job sits in exactly <strong>one</strong> stage and moves left to right as it progresses.{' '}
          <strong>Sold</strong> = created, no date yet (shows every month until scheduled) ·{' '}
          <strong>Scheduled</strong> = has a date, work not done ·{' '}
          <strong>Completed</strong> = work done, not yet invoiced ·{' '}
          <strong>Invoiced</strong> = invoice sent, awaiting payment ·{' '}
          <strong>Payment Received</strong> = customer paid — commission is payable only on these.
        </p>
      </div>

      {/* Adjustments */}
      {(detail.adjustments.length > 0 || admin) && (
        <AdjustmentsSection detail={detail} admin={admin} />
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
                  {admin && <th className="text-right px-3 py-3 font-medium text-gray-600">Eligibility</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {detail.jobs.length === 0 ? (
                  <tr><td colSpan={colSpan} className="px-4 py-6 text-center text-gray-400">No jobs this period.</td></tr>
                ) : detail.jobs.map(j => (
                  <tr key={j.sf_job_id} className={j.accepted ? '' : 'bg-gray-50 opacity-60'}>
                    <td className="px-4 py-2 text-gray-900">{j.customer_name ?? '—'}</td>
                    <td className="px-3 py-2 text-gray-600">{j.job_number ?? j.sf_job_id}</td>
                    <td className="px-3 py-2 text-gray-600">{j.date ?? '—'}</td>
                    <td className="px-3 py-2 text-right text-gray-700">{formatMoney(j.revenue)}</td>
                    <td className="px-3 py-2 text-center"><StageBadge stage={j.stage} /></td>
                    <td className="px-3 py-2 text-right text-gray-900 font-medium">
                      {j.accepted ? (
                        <>
                          {formatMoney(j.commission)}
                          {j.projected && <span className="ml-1 text-xs text-gray-400">(est.)</span>}
                        </>
                      ) : (
                        <span className="text-xs text-gray-400">Denied</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {j.received
                        ? <span className="text-xs text-green-600">Received</span>
                        : <span className="text-xs text-amber-600">Payment pending</span>}
                    </td>
                    {admin && (
                      <td className="px-3 py-2 text-right">
                        <button
                          disabled={busyJob === j.sf_job_id}
                          onClick={() => toggleEligibility(j.sf_job_id, !j.accepted)}
                          className={`text-xs px-2 py-0.5 rounded border disabled:opacity-50 ${
                            j.accepted
                              ? 'border-red-300 text-red-600 hover:bg-red-50'
                              : 'border-green-300 text-green-700 hover:bg-green-50'
                          }`}
                        >
                          {busyJob === j.sf_job_id ? '…' : j.accepted ? 'Deny' : 'Accept'}
                        </button>
                      </td>
                    )}
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

function AdjustmentsSection({ detail, admin }: { detail: TechPeriodDetail; admin?: AdminControls }) {
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function add() {
    if (!admin) return
    const amt = parseFloat(amount)
    if (!isFinite(amt) || amt === 0) { setError('Enter a non-zero amount'); return }
    if (!note.trim()) { setError('A note is required'); return }
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/admin/commission/adjustments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tech_user_id: admin.techUserId,
          period_start: admin.periodStart,
          period_end: admin.periodEnd,
          amount: amt,
          note: note.trim(),
        }),
      })
      if (!res.ok) throw new Error((await res.json()).error || 'Failed')
      setAmount(''); setNote('')
      admin.onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    if (!admin) return
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/admin/commission/adjustments?id=${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error((await res.json()).error || 'Failed')
      admin.onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-700 mb-2">Adjustments</h3>
      {admin && (
        <p className="text-xs text-gray-400 mb-2">
          Adjustments are entered as <strong>received revenue</strong> (a fake already-paid job): they
          count toward the target and earn commission at the tier rate — not a flat dollar add to the payout.
        </p>
      )}
      <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
        {detail.adjustments.map(a => (
          <div key={a.id} className="flex items-center justify-between px-4 py-2 text-sm">
            <span className="text-gray-600">{a.note}</span>
            <div className="flex items-center gap-3">
              <span className={a.amount < 0 ? 'text-red-600' : 'text-green-700'}>
                {a.amount < 0 ? '−' : '+'}{formatMoney(Math.abs(a.amount))}
              </span>
              {admin && (
                <button onClick={() => remove(a.id)} disabled={busy} className="text-gray-400 hover:text-red-600 disabled:opacity-50" title="Remove">×</button>
              )}
            </div>
          </div>
        ))}
        {detail.adjustments.length === 0 && (
          <div className="px-4 py-2 text-sm text-gray-400">No adjustments this period.</div>
        )}
        {admin && (
          <div className="px-4 py-3 flex flex-wrap items-center gap-2">
            <input
              type="number" inputMode="decimal" placeholder="Amount (+/−)"
              value={amount} onChange={e => setAmount(e.target.value)}
              className="border border-gray-300 rounded px-2 py-1 text-sm text-gray-900 w-32 focus:outline-none focus:ring-2 focus:ring-red-400"
            />
            <input
              type="text" placeholder="Note (required)"
              value={note} onChange={e => setNote(e.target.value)}
              className="border border-gray-300 rounded px-2 py-1 text-sm text-gray-900 flex-1 min-w-[180px] focus:outline-none focus:ring-2 focus:ring-red-400"
            />
            <button
              onClick={add} disabled={busy}
              className="bg-red-600 text-white rounded px-3 py-1 text-sm font-medium hover:bg-red-700 disabled:opacity-60"
            >
              {busy ? 'Saving…' : 'Add adjustment'}
            </button>
          </div>
        )}
      </div>
      {error && <div className="mt-1 text-xs text-red-600">{error}</div>}
    </div>
  )
}
