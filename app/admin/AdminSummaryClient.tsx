'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { weekLabel, getWeekEnd, getDeadlineForWeek, formatMoney, parseDate, isDeadlinePassed } from '@/lib/week'

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
  } | null
}

interface Job {
  id: string
  tech_id: string
  work_date: string
  job_name: string
  notes: string | null
  total_pay: number
  job_work_items: WorkItem[]
}

interface Tech {
  id: string
  full_name: string
  is_active: boolean
}

interface Submission {
  tech_id: string
  submitted_at: string
}

interface Props {
  selectedWeek: string
  currentWeek: string
  weeks: string[]
  techs: Tech[]
  jobs: Job[]
  submissions: Submission[]
}

export default function AdminSummaryClient({
  selectedWeek,
  currentWeek,
  weeks,
  techs,
  jobs,
  submissions,
}: Props) {
  const router = useRouter()
  const [expandedTech, setExpandedTech] = useState<string | null>(null)

  const submissionMap = new Map(submissions.map(s => [s.tech_id, s.submitted_at]))
  const deadlinePassed = isDeadlinePassed(selectedWeek)
  const deadline = getDeadlineForWeek(selectedWeek)

  const jobsByTech = new Map<string, Job[]>()
  for (const job of jobs) {
    if (!jobsByTech.has(job.tech_id)) jobsByTech.set(job.tech_id, [])
    jobsByTech.get(job.tech_id)!.push(job)
  }

  const grandTotal = jobs.reduce((s, j) => s + j.total_pay, 0)

  function techStatus(techId: string) {
    const sub = submissionMap.get(techId)
    if (sub) return { label: 'Submitted', color: 'text-green-700 bg-green-50' }
    if (deadlinePassed) return { label: 'Late / Not submitted', color: 'text-red-700 bg-red-50' }
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
          className="border border-gray-300 rounded-md px-3 py-1.5 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                <th className="text-right px-4 py-3 font-medium text-gray-600">Total Pay</th>
                <th className="w-8 px-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {techs.map(tech => {
                const techJobs = jobsByTech.get(tech.id) ?? []
                const techTotal = techJobs.reduce((s, j) => s + j.total_pay, 0)
                const sub = submissionMap.get(tech.id)
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
                        {sub
                          ? new Date(sub).toLocaleString('en-US', {
                              timeZone: 'America/Los_Angeles',
                              month: 'short', day: 'numeric',
                              hour: 'numeric', minute: '2-digit',
                            })
                          : '—'}
                      </td>
                      <td className="px-4 py-3 text-center text-gray-700">{techJobs.length}</td>
                      <td className="px-4 py-3 text-right font-semibold text-gray-900">
                        {formatMoney(techTotal)}
                      </td>
                      <td className="px-2 py-3 text-gray-400 text-xs">
                        {techJobs.length > 0 ? (isExpanded ? '▲' : '▼') : ''}
                      </td>
                    </tr>

                    {isExpanded && techJobs.length > 0 && (
                      <tr key={`${tech.id}-detail`}>
                        <td colSpan={6} className="bg-gray-50 px-4 py-3">
                          <div className="space-y-4 ml-2">
                            {techJobs.map(job => (
                              <div key={job.id} className="border-l-2 border-blue-200 pl-3">
                                <div className="flex justify-between items-start">
                                  <div>
                                    <p className="font-medium text-gray-800 text-sm">{job.job_name}</p>
                                    <p className="text-xs text-gray-500">{formatWorkDate(job.work_date)}</p>
                                    {job.notes && (
                                      <p className="text-xs text-gray-400 mt-0.5">Note: {job.notes}</p>
                                    )}
                                  </div>
                                  <p className="font-semibold text-gray-900 text-sm">{formatMoney(job.total_pay)}</p>
                                </div>
                                <ul className="mt-1 space-y-0.5">
                                  {job.job_work_items.map(item => (
                                    <li key={item.id} className="flex justify-between text-xs text-gray-600">
                                      <span>
                                        {item.custom_description
                                          ? `Other: ${item.custom_description}`
                                          : (item.job_types?.name ?? 'Unknown')}
                                        {!item.custom_description && item.job_types?.requires_quantity ? ` × ${item.quantity}` : ''}
                                      </span>
                                      <span className="font-medium ml-2">{formatMoney(item.calculated_pay)}</span>
                                    </li>
                                  ))}
                                </ul>
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
                <td className="px-4 py-3 text-right font-bold text-gray-900 text-base">{formatMoney(grandTotal)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  )
}
