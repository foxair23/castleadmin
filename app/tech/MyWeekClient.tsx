'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { weekLabel, getWeekEnd, getDeadlineForWeek, isDeadlinePassed, formatMoney, parseDate } from '@/lib/week'

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
    requires_sale_amount: boolean
  } | null
}

interface SFLineItem {
  name: string | null
  quantity: number | null
}

interface Job {
  id: string
  work_date: string
  job_name: string
  notes: string | null
  total_pay: number
  week_start_date: string
  source: string
  sf_status: string | null
  sf_job_number: string | null
  sf_job_id: string | null
  sf_description: string | null
  gas_paid: boolean
  job_work_items: WorkItem[]
}

interface Props {
  userId: string
  selectedWeek: string
  currentWeek: string
  jobs: Job[]
  submittedAt: string | null
  adminUnlocked: boolean
  sfMapped: boolean
  weeklyBonus: number
  lastWeek: string
  showLastWeekNudge: boolean
  sfLineItems: Record<string, SFLineItem[]>
}

export default function MyWeekClient({ userId, selectedWeek, currentWeek, jobs, submittedAt, adminUnlocked, sfMapped, weeklyBonus, lastWeek, showLastWeekNudge, sfLineItems }: Props) {
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)
  const [unsubmitting, setUnsubmitting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncStatus, setSyncStatus] = useState('')
  const [syncResult, setSyncResult] = useState<{ added: number; updated: number } | null>(null)
  const [syncError, setSyncError] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null)
  const [showConfirm, setShowConfirm] = useState(false)
  const [showUnsubmitConfirm, setShowUnsubmitConfirm] = useState(false)
  const [unsubmitRedirect, setUnsubmitRedirect] = useState<string | null>(null)

  const isSubmitted = !!submittedAt
  const deadlinePassed = isDeadlinePassed(selectedWeek)
  // Locked if deadline passed AND not admin-unlocked AND already submitted (or never submitted)
  const isLocked = deadlinePassed && !adminUnlocked
  const weekEnd = getWeekEnd(selectedWeek)
  const deadline = getDeadlineForWeek(selectedWeek)

  const totalPay = jobs.reduce((sum, j) => sum + j.total_pay, 0) + weeklyBonus

  function isItemIncomplete(item: WorkItem): boolean {
    if (!item.job_types) return false
    if (item.job_types.name === 'Other' || item.job_types.requires_sale_amount) {
      return !item.custom_description || item.calculated_pay === 0
    }
    return false
  }

  const incompleteJobCount = jobs.filter(j => j.job_work_items.some(isItemIncomplete)).length

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

  async function handleSyncFromSF() {
    setSyncing(true)
    setSyncResult(null)
    setSyncError('')
    setSyncStatus('Connecting to Service Fusion…')

    const controller = new AbortController()
    const slowTimer = setTimeout(() => setSyncStatus('Still syncing — this can take up to 30 seconds…'), 8_000)
    const hardTimer = setTimeout(() => controller.abort(), 45_000)

    try {
      const res = await fetch('/api/tech/sf-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ week_start: selectedWeek }),
        signal: controller.signal,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Sync failed')
      setSyncResult({ added: data.added, updated: data.updated })
      router.refresh()
    } catch (err: unknown) {
      const msg = err instanceof Error
        ? (err.name === 'AbortError' ? 'Sync timed out — Service Fusion may be slow. Please try again.' : err.message)
        : 'Sync failed'
      setSyncError(msg)
    } finally {
      clearTimeout(slowTimer)
      clearTimeout(hardTimer)
      setSyncing(false)
      setSyncStatus('')
    }
  }

  async function handleSubmitWeek() {
    setSubmitting(true)
    const supabase = createClient()
    // Use upsert in case an admin_unlocked record already exists for this week
    const { error } = await supabase.from('week_submissions').upsert(
      { tech_id: userId, week_start_date: selectedWeek, submitted_at: new Date().toISOString(), admin_unlocked: false },
      { onConflict: 'tech_id,week_start_date' }
    )
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

  const isPastWeek = selectedWeek < currentWeek

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        {isPastWeek && (
          <Link href="/tech/history" className="text-sm text-red-600 hover:underline">
            ← Back to History
          </Link>
        )}
        <h1 className="text-xl font-bold text-gray-900 mt-1">
          {isPastWeek ? weekLabel(selectedWeek) : 'My Week'}
        </h1>
        {!isPastWeek && <p className="text-sm text-gray-500">{weekLabel(selectedWeek)}</p>}
      </div>

      {/* Last week unsubmitted nudge */}
      {showLastWeekNudge && (
        <Link
          href={`/tech?week=${lastWeek}`}
          className="flex items-center justify-between gap-3 bg-amber-50 border border-amber-300 rounded-lg px-4 py-3 text-sm text-amber-900 hover:bg-amber-100 transition-colors"
        >
          <span>⚠️ Last week was not submitted — tap to review and submit.</span>
          <span className="shrink-0 font-medium underline">View →</span>
        </Link>
      )}

      {/* Status banner — only for special states */}
      {isSubmitted && !deadlinePassed && (
        <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-xs text-green-800 flex items-center justify-between gap-3">
          <span>Submitted {new Date(submittedAt!).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.</span>
          <button onClick={() => openUnsubmitConfirm()} className="shrink-0 font-medium text-green-700 underline hover:text-green-900">
            Edit Submission
          </button>
        </div>
      )}
      {isSubmitted && deadlinePassed && !adminUnlocked && (
        <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-xs text-green-800">
          Submitted — deadline passed, week is locked.
        </div>
      )}
      {!isSubmitted && deadlinePassed && !adminUnlocked && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-800">
          Deadline passed — this week is locked.
        </div>
      )}
      {adminUnlocked && !isSubmitted && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-xs text-blue-800">
          Unlocked by admin — add or edit your jobs, then re-submit.
        </div>
      )}

      {/* Action row: deadline pill + sync + bulk update */}
      <div className="flex items-center gap-2 flex-wrap">
        {!isSubmitted && !deadlinePassed && (
          <span className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-full px-3 py-1 shrink-0">
            Due {deadline.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} 11:59 PM
          </span>
        )}

        {sfMapped && (
          <button
            onClick={handleSyncFromSF}
            disabled={syncing || !!submittedAt}
            className="text-sm font-medium px-3 py-1.5 rounded-md bg-gray-800 text-white hover:bg-gray-700 disabled:opacity-50 transition-colors shrink-0"
          >
            {syncing ? 'Syncing…' : '↓ Sync from SF'}
          </button>
        )}

        {!isLocked && !isSubmitted && jobs.length > 0 && (
          <Link
            href={`/tech/bulk-update?week=${selectedWeek}`}
            className="text-sm font-medium px-3 py-1.5 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors shrink-0"
          >
            ⚡ Bulk Edit
          </Link>
        )}

        {syncResult && (
          <span className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-2 py-1">
            Synced: {syncResult.added} new, {syncResult.updated} updated
          </span>
        )}
        {syncError && (
          <span className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
            {syncError}
          </span>
        )}
        {syncStatus && (
          <span className="text-xs text-gray-500">{syncStatus}</span>
        )}
      </div>

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
                  <div key={job.id} className={`bg-white border rounded-lg p-4 ${job.job_work_items.some(isItemIncomplete) ? 'border-amber-300' : 'border-gray-200'}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-medium text-gray-900 text-sm truncate">{job.job_name}</p>
                          <SFBadge source={job.source} sfStatus={job.sf_status} />
                          {job.sf_job_number && (
                            <span className="text-xs text-gray-400 font-mono shrink-0">SF #{job.sf_job_number}</span>
                          )}
                          {job.job_work_items.some(isItemIncomplete) && (
                            <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded font-medium shrink-0">
                              Needs details
                            </span>
                          )}
                        </div>
                        {job.notes && (
                          <p className="text-xs text-gray-500 mt-0.5">{job.notes}</p>
                        )}
                        {job.sf_description && (
                          <p className="text-xs text-gray-400 mt-0.5 italic">{job.sf_description}</p>
                        )}
                        <ul className="mt-2 space-y-1">
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
                          <div className="mt-2 pt-2 border-t border-gray-100">
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
        {weeklyBonus > 0 && (
          <div className="flex items-center justify-between text-sm text-purple-700">
            <span>Weekly Bonus</span>
            <span>{formatMoney(weeklyBonus)}</span>
          </div>
        )}
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-gray-700">Week Total</span>
          <span className="text-lg font-bold text-gray-900">{formatMoney(totalPay)}</span>
        </div>

        {!isLocked && !isSubmitted && incompleteJobCount > 0 && (
          <div className="bg-amber-50 border border-amber-300 rounded-lg px-3 py-2 text-xs text-amber-800">
            {incompleteJobCount} job{incompleteJobCount !== 1 ? 's need' : ' needs'} details before submitting — tap Edit on each highlighted job.
          </div>
        )}

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
              {adminUnlocked ? 'Re-submit Week' : 'Submit Week'}
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

function SFBadge({ source, sfStatus }: { source: string; sfStatus: string | null }) {
  if (source !== 'service_fusion') {
    return (
      <span className="inline-block text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-medium shrink-0">
        Manual
      </span>
    )
  }
  if (sfStatus === 'completed') {
    return (
      <span className="inline-block text-xs px-1.5 py-0.5 rounded bg-green-100 text-green-700 font-medium shrink-0">
        SF: Completed
      </span>
    )
  }
  return (
    <span className="inline-block text-xs px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-700 font-medium shrink-0">
      SF: Assigned
    </span>
  )
}
