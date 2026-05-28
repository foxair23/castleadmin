'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { weekLabel, getDeadlineForWeek, formatMoney, parseDate, isDeadlinePassed } from '@/lib/week'

interface WorkItem {
  id: string
  quantity: number
  calculated_pay: number
  custom_description: string | null
  job_types: {
    name: string
    base_rate: number
    additional_rate: number | null
    requires_quantity: boolean
    requires_sale_amount: boolean
  } | null
}

interface SFLineItem {
  name: string | null
  quantity: number | null
}

interface Job {
  id: string
  tech_id: string
  work_date: string
  job_name: string
  notes: string | null
  total_pay: number
  source: string
  gas_paid: boolean
  sf_job_id: string | null
  sf_description: string | null
  job_work_items: WorkItem[]
}

interface Tech {
  id: string
  full_name: string
  is_active: boolean
  weekly_bonus: number
}

interface Submission {
  tech_id: string
  submitted_at: string | null
  admin_unlocked: boolean
}

interface Props {
  selectedWeek: string
  currentWeek: string
  weeks: string[]
  techs: Tech[]
  jobs: Job[]
  submissions: Submission[]
  sfLineItems: Record<string, SFLineItem[]>
}

export default function AdminSummaryClient({
  selectedWeek,
  currentWeek,
  weeks,
  techs,
  jobs,
  submissions,
  sfLineItems,
}: Props) {
  const router = useRouter()
  const [expandedTech, setExpandedTech] = useState<string | null>(null)
  const [unlocking, setUnlocking] = useState<string | null>(null)

  const submissionMap = new Map(submissions.map(s => [s.tech_id, s]))
  const deadlinePassed = isDeadlinePassed(selectedWeek)
  const deadline = getDeadlineForWeek(selectedWeek)

  async function handleToggleUnlock(techId: string, currentlyUnlocked: boolean) {
    setUnlocking(techId)
    await fetch('/api/admin/weeks/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tech_id: techId, week_start_date: selectedWeek, lock: currentlyUnlocked }),
    })
    setUnlocking(null)
    router.refresh()
  }

  const jobsByTech = new Map<string, Job[]>()
  for (const job of jobs) {
    if (!jobsByTech.has(job.tech_id)) jobsByTech.set(job.tech_id, [])
    jobsByTech.get(job.tech_id)!.push(job)
  }

  const bonusById = new Map(techs.map(t => [t.id, t.weekly_bonus ?? 0]))
  const grandGas = jobs.reduce((s, j) => s + (j.gas_paid ? 20 : 0), 0)
  const grandEarnings = jobs.reduce((s, j) => s + j.total_pay - (j.gas_paid ? 20 : 0), 0) +
    techs.reduce((s, t) => s + (t.weekly_bonus ?? 0), 0)
  const grandTotal = grandEarnings + grandGas

  function techStatus(techId: string) {
    const sub = submissionMap.get(techId)
    if (sub?.submitted_at) return { label: 'Submitted', color: 'text-green-700 bg-green-50' }
    if (sub?.admin_unlocked) return { label: 'Unlocked for editing', color: 'text-blue-700 bg-blue-50' }
    if (deadlinePassed) return { label: 'Late / Not submitted', color: 'text-red-600 bg-red-50' }
    return { label: 'Not submitted', color: 'text-yellow-700 bg-yellow-50' }
  }

  function formatWorkDate(dateStr: string) {
    const d = parseDate(dateStr)
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Weekly Summary</h1>
          <p className="text-sm text-gray-500">{weekLabel(selectedWeek)}</p>
        </div>
        <select
          value={selectedWeek}
          onChange={e => router.push(`/admin?week=${e.target.value}`)}
          className="border border-gray-300 rounded-md px-3 py-1.5 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-red-400"
        >
          {weeks.map(w => (
            <option key={w} value={w}>
              {w === currentWeek ? `Current week (${w})` : w}
            </option>
          ))}
        </select>
      </div>

      {/* Submission deadline info */}
      <div className="text-xs text-gray-500">
        Submission deadline: {deadline.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} at 11:59 PM PT
        {deadlinePassed && <span className="ml-2 text-red-600 font-medium">(Passed)</span>}
      </div>

      {/* Summary table */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-3 font-medium text-gray-600">Technician</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 hidden sm:table-cell">Submitted</th>
                <th className="text-center px-4 py-3 font-medium text-gray-600">Jobs</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Earnings</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600 hidden sm:table-cell">Gas</th>
                <th className="text-center px-4 py-3 font-medium text-gray-600 hidden sm:table-cell">Unlock</th>
                <th className="w-8 px-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {techs.map(tech => {
                const techJobs = jobsByTech.get(tech.id) ?? []
                const bonus = bonusById.get(tech.id) ?? 0
                const techGas = techJobs.reduce((s, j) => s + (j.gas_paid ? 20 : 0), 0)
                const techEarnings = techJobs.reduce((s, j) => s + j.total_pay - (j.gas_paid ? 20 : 0), 0) + bonus
                const techTotal = techEarnings + techGas
                const sub = submissionMap.get(tech.id)
                const isUnlocked = sub?.admin_unlocked === true && !sub?.submitted_at
                const status = techStatus(tech.id)
                const isExpanded = expandedTech === tech.id

                return (
                  <>
                    <tr
                      key={tech.id}
                      onClick={() => setExpandedTech(isExpanded ? null : tech.id)}
                      className="cursor-pointer hover:bg-gray-50 transition-colors"
                    >
                      <td className="px-4 py-3 font-medium text-gray-900">
                        {tech.full_name}
                        {!tech.is_active && <span className="ml-1 text-xs text-gray-400">(inactive)</span>}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${status.color}`}>
                          {status.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500 hidden sm:table-cell">
                        {sub?.submitted_at
                          ? new Date(sub.submitted_at).toLocaleString('en-US', {
                              timeZone: 'America/Los_Angeles',
                              month: 'short', day: 'numeric',
                              hour: 'numeric', minute: '2-digit',
                            })
                          : '—'}
                      </td>
                      <td className="px-4 py-3 text-center text-gray-700">{techJobs.length}</td>
                      <td className="px-4 py-3 text-right font-semibold text-gray-900">
                        {formatMoney(techEarnings)}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-amber-700 hidden sm:table-cell">
                        {techGas > 0 ? formatMoney(techGas) : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-4 py-3 text-center hidden sm:table-cell" onClick={e => e.stopPropagation()}>
                        {deadlinePassed && (
                          <button
                            onClick={() => handleToggleUnlock(tech.id, isUnlocked)}
                            disabled={unlocking === tech.id}
                            className={`text-xs px-2 py-0.5 rounded font-medium disabled:opacity-50 ${
                              isUnlocked
                                ? 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                            }`}
                          >
                            {unlocking === tech.id ? '…' : isUnlocked ? 'Unlocked' : 'Unlock'}
                          </button>
                        )}
                      </td>
                      <td className="px-2 py-3 text-gray-400 text-xs">
                        {techJobs.length > 0 ? (isExpanded ? '▲' : '▼') : ''}
                      </td>
                    </tr>

                    {isExpanded && (techJobs.length > 0 || bonus > 0) && (
                      <tr key={`${tech.id}-detail`}>
                        <td colSpan={8} className="bg-gray-50 px-4 py-3">
                          <div className="space-y-4 ml-2">
                            {bonus > 0 && (
                              <div className="border-l-2 border-purple-300 pl-3 flex justify-between items-center">
                                <div>
                                  <p className="font-medium text-gray-800 text-sm">Weekly Bonus</p>
                                  <p className="text-xs text-gray-500">Flat weekly stipend</p>
                                </div>
                                <p className="font-semibold text-gray-900 text-sm">{formatMoney(bonus)}</p>
                              </div>
                            )}
                            {techJobs.map(job => (
                              <div key={job.id} className={`border-l-2 pl-3 ${job.source === 'service_fusion' ? 'border-red-300' : 'border-blue-300'}`}>
                                <div className="flex justify-between items-start">
                                  <div>
                                    <p className="font-medium text-gray-800 text-sm">{job.job_name}</p>
                                    <p className="text-xs text-gray-500">{formatWorkDate(job.work_date)}</p>
                                    {job.notes && (
                                      <p className="text-xs text-gray-400 mt-0.5">Note: {job.notes}</p>
                                    )}
                                  {job.sf_description && (
                                      <p className="text-xs text-gray-400 mt-0.5 italic">{job.sf_description}</p>
                                    )}
                                  </div>
                                  <p className="font-semibold text-gray-900 text-sm">{formatMoney(job.total_pay)}</p>
                                </div>
                                <ul className="mt-1 space-y-0.5">
                                  {job.job_work_items.map(item => (
                                    <li key={item.id} className="flex justify-between text-xs text-gray-600">
                                      <span>
                                        {item.job_types?.requires_sale_amount && item.custom_description
                                          ? `New Sale Commission (Sale: ${formatMoney(parseFloat(item.custom_description))})`
                                          : item.custom_description
                                            ? `Other: ${item.custom_description}`
                                            : (item.job_types?.name ?? 'Unknown')}
                                        {!item.custom_description && item.job_types?.requires_quantity ? ` × ${item.quantity}` : ''}
                                      </span>
                                      <span className="font-medium ml-2">{formatMoney(item.calculated_pay)}</span>
                                    </li>
                                  ))}
                                  {job.gas_paid && (
                                    <li className="flex justify-between text-xs text-amber-700">
                                      <span>⛽ Gas reimbursement</span>
                                      <span className="font-medium ml-2">{formatMoney(20)}</span>
                                    </li>
                                  )}
                                </ul>
                                {job.sf_job_id && sfLineItems[job.sf_job_id]?.length > 0 && (
                                  <div className="mt-2 pt-2 border-t border-gray-200">
                                    <p className="text-xs text-gray-400 font-medium mb-1">Products sold</p>
                                    <ul className="space-y-0.5">
                                      {sfLineItems[job.sf_job_id].map((item, i) => (
                                        <li key={i} className="text-xs text-gray-500">
                                          {item.name ?? 'Unknown product'}
                                          {item.quantity != null && item.quantity !== 1 ? ` ×${item.quantity}` : ''}
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
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
            <tfoot>
              <tr className="bg-gray-50 border-t-2 border-gray-200">
                <td colSpan={4} className="px-4 py-3 font-bold text-gray-900">Grand Total</td>
                <td className="px-4 py-3 text-right font-bold text-gray-900 text-base">{formatMoney(grandEarnings)}</td>
                <td className="px-4 py-3 text-right font-bold text-amber-700 text-base hidden sm:table-cell">
                  {grandGas > 0 ? formatMoney(grandGas) : <span className="text-gray-300">—</span>}
                </td>
                <td></td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  )
}
