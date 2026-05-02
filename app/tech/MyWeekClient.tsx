'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { weekLabel, getWeekEnd, getDeadlineForWeek, isDeadlinePassed, formatMoney, parseDate, formatDate } from '@/lib/week'

interface WorkItem {
  id: string
  quantity: number
  calculated_pay: number
  custom_description: string | null
  job_types: {
    id: string
    name: string
    base_rate: number
    additional_rate: number | null
    requires_quantity: boolean
  } | null
}

interface Job {
  id: string
  work_date: string
  job_name: string
  notes: string | null
  total_pay: number
  week_start_date: string
  job_work_items: WorkItem[]
}

interface Props {
  userId: string
  selectedWeek: string
  currentWeek: string
  weeks: string[]
  jobs: Job[]
  submittedAt: string | null
}

export default function MyWeekClient({ userId, selectedWeek, currentWeek, weeks, jobs, submittedAt }: Props) {
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)
  const [unsubmitting, setUnsubmitting] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [showConfirm, setShowConfirm] = useState(false)
  const [showUnsubmitConfirm, setShowUnsubmitConfirm] = useState(false)
  const [unsubmitRedirect, setUnsubmitRedirect] = useState<string | null>(null)

  const isSubmitted = !!submittedAt
  const deadlinePassed = isDeadlinePassed(selectedWeek)
  const isLocked = isSubmitted && deadlinePassed
  const weekEnd = getWeekEnd(selectedWeek)
  const deadline = getDeadlineForWeek(selectedWeek)

  const totalPay = jobs.reduce((sum, j) => sum + j.total_pay, 0)

  // Group jobs by date
  const byDate = jobs.reduce<Record<string, Job[]>>((acc, job) => {
    const d = job.work_date
    if (!acc[d]) acc[d] = []
    acc[d].push(job)
    return acc
  }, {})

  const sortedDates = Object.keys(byDate).sort()

  async function handleDelete(jobId: string) {
    setDeleting(jobId)
    const supabase = createClient()
    await supabase.from('jobs').delete().eq('id', jobId)
    router.refresh()
    setDeleting(null)
  }

  function openUnsubmitConfirm(redirectTo?: string) {
    setUnsubmitRedirect(redirectTo ?? null)
    setShowUnsubmitConfirm(true)
  }

  async function handleUnsubmitWeek() {
    setUnsubmitting(true)
    const supabase = createClient()
    const { error } = await supabase
      .from('week_submissions')
      .delete()
      .eq('tech_id', userId)
      .eq('week_start_date', selectedWeek)
    if (error) {
      alert('Failed to reopen week: ' + error.message)
      setUnsubmitting(false)
    } else {
      setShowUnsubmitConfirm(false)
      if (unsubmitRedirect) {
        router.push(unsubmitRedirect)
      } else {
        router.refresh()
      }
    }
  }

  async function handleSubmitWeek() {
    setSubmitting(true)
    const supabase = createClient()
    const { error } = await supabase.from('week_submissions').insert({
      tech_id: userId,
      week_start_date: selectedWeek,
    })
    if (error) {
      alert('Failed to submit week: ' + error.message)
      setSubmitting(false)
    } else {
      setShowConfirm(false)
      router.refresh()
    }
  }

  function formatWorkDate(dateStr: string) {
    const d = parseDate(dateStr)
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">My Week</h1>
          <p className="text-sm text-gray-500">{weekLabel(selectedWeek)}</p>
        </div>

        {/* Week selector */}
        <select
          value={selectedWeek}
          onChange={e => router.push(`/tech?week=${e.target.value}`)}
          className="border border-gray-300 rounded-md px-3 py-1.5 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-red-400"
        >
          {weeks.map(w => (
            <option key={w} value={w}>
              {w === currentWeek ? `This week (${w})` : w}
            </option>
          ))}
        </select>
      </div>

      {/* Status banner */}
      {isSubmitted && !deadlinePassed && (
        <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm text-green-800 flex items-center justify-between gap-3">
          <span>Submitted on {new Date(submittedAt!).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}.</span>
          <button
            onClick={() => openUnsubmitConfirm()}
            className="shrink-0 text-xs font-medium text-green-700 underline hover:text-green-900"
          >
            Edit Submission
          </button>
        </div>
      )}
      {isSubmitted && deadlinePassed && (
        <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm text-green-800">
          Week submitted on {new Date(submittedAt!).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}. Deadline has passed — this week is locked.
        </div>
      )}
      {!isSubmitted && deadlinePassed && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800">
          Submission deadline passed ({deadline.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} 11:59 PM). This week is locked.
        </div>
      )}
      {!isSubmitted && !deadlinePassed && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800">
          Deadline: {deadline.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} at 11:59 PM PT
        </div>
      )}

      {/* Jobs list */}
      {jobs.length === 0 ? (
        <div className="text-center py-12 text-gray-400 text-sm">
          No jobs logged for this week yet.
        </div>
      ) : (
        <div className="space-y-4">
          {sortedDates.map(date => (
            <div key={date}>
              <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                {formatWorkDate(date)}
              </h2>
              <div className="space-y-2">
                {byDate[date].map(job => (
                  <div key={job.id} className="bg-white border border-gray-200 rounded-lg p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-gray-900 text-sm truncate">{job.job_name}</p>
                        {job.notes && (
                          <p className="text-xs text-gray-500 mt-0.5">{job.notes}</p>
                        )}
                        <ul className="mt-2 space-y-1">
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
                      <div className="text-right shrink-0">
                        <p className="font-bold text-gray-900 text-sm">{formatMoney(job.total_pay)}</p>
                        {(!isLocked || (isSubmitted && !deadlinePassed)) && (
                          <div className="flex gap-2 mt-1 justify-end">
                            {isSubmitted && !deadlinePassed ? (
                              <>
                                <button
                                  onClick={() => openUnsubmitConfirm(`/tech/jobs/${job.id}/edit`)}
                                  className="text-xs text-red-600 hover:underline"
                                >
                                  Edit
                                </button>
                                <button
                                  onClick={() => openUnsubmitConfirm()}
                                  className="text-xs text-red-500 hover:underline"
                                >
                                  Delete
                                </button>
                              </>
                            ) : (
                              <>
                                <Link
                                  href={`/tech/jobs/${job.id}/edit`}
                                  className="text-xs text-red-600 hover:underline"
                                >
                                  Edit
                                </Link>
                                <button
                                  onClick={() => handleDelete(job.id)}
                                  disabled={deleting === job.id}
                                  className="text-xs text-red-500 hover:underline disabled:opacity-50"
                                >
                                  {deleting === job.id ? 'Deleting…' : 'Delete'}
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Footer */}
      <div className="sticky bottom-0 bg-gray-50 border-t border-gray-200 pt-4 mt-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-gray-700">Week Total</span>
          <span className="text-lg font-bold text-gray-900">{formatMoney(totalPay)}</span>
        </div>

        {!isLocked && !isSubmitted && (
          <div className="flex gap-3">
            <Link
              href={`/tech/jobs/new?week=${selectedWeek}`}
              className="flex-1 text-center bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium py-2 px-4 rounded-md text-sm transition-colors"
            >
              + Add Job
            </Link>
            <button
              onClick={() => setShowConfirm(true)}
              disabled={jobs.length === 0}
              className="flex-1 bg-red-600 hover:bg-red-600 disabled:opacity-40 text-white font-medium py-2 px-4 rounded-md text-sm transition-colors"
            >
              Submit Week
            </button>
          </div>
        )}
        {isSubmitted && !deadlinePassed && (
          <div className="flex gap-3">
            <button
              onClick={() => openUnsubmitConfirm(`/tech/jobs/new?week=${selectedWeek}`)}
              className="flex-1 text-center bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium py-2 px-4 rounded-md text-sm transition-colors"
            >
              + Add Job
            </button>
            <button
              onClick={() => setShowConfirm(true)}
              disabled={jobs.length === 0}
              className="flex-1 bg-red-600 hover:bg-red-600 disabled:opacity-40 text-white font-medium py-2 px-4 rounded-md text-sm transition-colors"
            >
              Re-submit Week
            </button>
          </div>
        )}
      </div>

      {/* Unsubmit confirmation modal */}
      {showUnsubmitConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full">
            <h3 className="text-lg font-bold text-gray-900 mb-2">Edit your submission?</h3>
            <p className="text-sm text-gray-600 mb-4">
              This will reopen your week so you can make changes. You&apos;ll need to re-submit before the deadline.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowUnsubmitConfirm(false)}
                className="flex-1 border border-gray-300 text-gray-700 rounded-md py-2 text-sm hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleUnsubmitWeek}
                disabled={unsubmitting}
                className="flex-1 bg-yellow-500 text-white rounded-md py-2 text-sm hover:bg-yellow-600 disabled:opacity-60"
              >
                {unsubmitting ? 'Reopening…' : 'Yes, Edit'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Submit confirmation modal */}
      {showConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full">
            <h3 className="text-lg font-bold text-gray-900 mb-2">Submit your week?</h3>
            <p className="text-sm text-gray-600 mb-4">
              Submit your week of <strong>{weekLabel(selectedWeek)}</strong>?
              You won&apos;t be able to edit it after submission.
            </p>
            <p className="text-sm font-semibold text-gray-700 mb-4">
              Total pay: {formatMoney(totalPay)}
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowConfirm(false)}
                className="flex-1 border border-gray-300 text-gray-700 rounded-md py-2 text-sm hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmitWeek}
                disabled={submitting}
                className="flex-1 bg-red-600 text-white rounded-md py-2 text-sm hover:bg-red-600 disabled:opacity-60"
              >
                {submitting ? 'Submitting…' : 'Yes, Submit'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
