'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { CommissionReviewItem } from '@/lib/analytics/alerts'

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}
function fmtDate(s: string | null): string {
  if (!s) return '—'
  return new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

interface Props {
  items: CommissionReviewItem[]
  techs: { id: string; full_name: string }[]
}

// Resolve queue for commission jobs the engine couldn't auto-credit.
// - unmapped_agent: map the single agent to a tech (or mark not accepted).
// - multiple_agents: pick which agent's tech credits the job (or not accepted).
export default function CommissionReviewTable({ items, techs }: Props) {
  const router = useRouter()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')
  // Per-row selected tech (for the dropdowns).
  const [picks, setPicks] = useState<Record<string, string>>({})

  async function resolve(id: string, body: Record<string, unknown>) {
    setBusyId(id)
    setError('')
    try {
      const res = await fetch('/api/admin/commission/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-2">
      {error && (
        <div className="bg-red-50 border border-red-200 rounded px-3 py-2 text-sm text-red-600">{error}</div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-y border-gray-200">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Customer</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Job #</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Completed</th>
              <th className="px-3 py-2 text-right text-xs font-semibold text-gray-500 uppercase tracking-wide">Revenue</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Reason</th>
              <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Resolve</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {items.map(item => {
              const busy = busyId === item.id
              const reason = item.review_reason
              return (
                <tr key={item.id} className="hover:bg-gray-50 align-top">
                  <td className="px-4 py-3 font-medium text-gray-900">{item.customer_name ?? '—'}</td>
                  <td className="px-3 py-3 text-gray-600">{item.job_number ?? item.sf_job_id}</td>
                  <td className="px-3 py-3 text-gray-600 whitespace-nowrap">{fmtDate(item.recognition_date)}</td>
                  <td className="px-3 py-3 text-right font-medium text-gray-700">{fmtMoney(item.revenue)}</td>
                  <td className="px-3 py-3">
                    <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700 whitespace-nowrap">
                      {reason === 'multiple_agents' ? 'Multiple agents' : 'Unmapped agent'}
                    </span>
                    <div className="mt-1 text-xs text-gray-500">
                      {item.agents.map((a, i) => (
                        <div key={i}>
                          {a.name}{a.mapped_tech_name ? ` → ${a.mapped_tech_name}` : ' (unmapped)'}
                        </div>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-2 min-w-[240px]">
                      {reason === 'unmapped_agent' ? (
                        // Map the single agent to a tech.
                        <div className="flex items-center gap-2">
                          <select
                            value={picks[item.id] ?? ''}
                            disabled={busy}
                            onChange={e => setPicks(p => ({ ...p, [item.id]: e.target.value }))}
                            className="border border-gray-300 rounded px-2 py-1 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-400 disabled:opacity-60"
                          >
                            <option value="">Map agent to…</option>
                            {techs.map(t => <option key={t.id} value={t.id}>{t.full_name}</option>)}
                          </select>
                          <button
                            disabled={busy || !picks[item.id]}
                            onClick={() => {
                              const a = item.agents[0]
                              resolve(item.id, {
                                action: 'map',
                                agent_id: a?.agent_id ?? null,
                                agent_first_name: a?.name?.split(' ')[0] ?? null,
                                agent_last_name: a?.name?.split(' ').slice(1).join(' ') || null,
                                tech_user_id: picks[item.id],
                              })
                            }}
                            className="text-xs px-2 py-1 rounded border border-green-300 text-green-700 hover:bg-green-50 disabled:opacity-50"
                          >
                            Map &amp; credit
                          </button>
                        </div>
                      ) : (
                        // Pick which agent's tech credits the job.
                        <div className="flex items-center gap-2">
                          <select
                            value={picks[item.id] ?? ''}
                            disabled={busy}
                            onChange={e => setPicks(p => ({ ...p, [item.id]: e.target.value }))}
                            className="border border-gray-300 rounded px-2 py-1 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-400 disabled:opacity-60"
                          >
                            <option value="">Credit…</option>
                            {item.agents.filter(a => a.mapped_tech_user_id).map((a, i) => (
                              <option key={i} value={a.mapped_tech_user_id!}>{a.name} → {a.mapped_tech_name}</option>
                            ))}
                            {techs.map(t => <option key={t.id} value={t.id}>{t.full_name}</option>)}
                          </select>
                          <button
                            disabled={busy || !picks[item.id]}
                            onClick={() => resolve(item.id, { action: 'credit', eligibility_id: item.id, tech_user_id: picks[item.id] })}
                            className="text-xs px-2 py-1 rounded border border-green-300 text-green-700 hover:bg-green-50 disabled:opacity-50"
                          >
                            Credit
                          </button>
                        </div>
                      )}
                      <button
                        disabled={busy}
                        onClick={() => resolve(item.id, { action: 'not_accepted', eligibility_id: item.id })}
                        className="self-start text-xs px-2 py-1 rounded border border-gray-300 text-gray-500 hover:bg-gray-50 disabled:opacity-50"
                      >
                        Not accepted
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
