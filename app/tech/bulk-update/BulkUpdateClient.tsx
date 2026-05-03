'use client'

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { calculateItemPay, formatMoney, parseDate, weekLabel } from '@/lib/week'

interface JobType {
  id: string
  name: string
  base_rate: number
  additional_rate: number | null
  requires_quantity: boolean
}

interface WorkItem {
  id: string
  job_type_id: string
  quantity: number
  calculated_pay: number
  custom_description: string | null
}

interface Job {
  id: string
  work_date: string
  job_name: string
  total_pay: number
  source: string
  sf_status: string | null
  job_work_items: WorkItem[]
}

interface RowDraft {
  jobTypeId: string
  quantity: number
  customDescription: string
  customAmount: string
  isDirty: boolean
}

interface Props {
  selectedWeek: string
  jobs: Job[]
  jobTypes: JobType[]
  isLocked: boolean
}

function initDraft(job: Job, jobTypes: JobType[], otherTypeId: string): RowDraft {
  const items = job.job_work_items
  if (items.length === 1) {
    const item = items[0]
    const isOther = item.job_type_id === otherTypeId
    return {
      jobTypeId: item.job_type_id,
      quantity: item.quantity,
      customDescription: item.custom_description ?? '',
      customAmount: isOther ? String(item.calculated_pay) : '',
      isDirty: false,
    }
  }
  // No items or multiple items: default to first job type
  const first = jobTypes[0]
  return {
    jobTypeId: first?.id ?? '',
    quantity: 1,
    customDescription: '',
    customAmount: '',
    isDirty: false,
  }
}

function formatWorkDate(dateStr: string) {
  return parseDate(dateStr).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

export default function BulkUpdateClient({ selectedWeek, jobs, jobTypes, isLocked }: Props) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [savedCount, setSavedCount] = useState<number | null>(null)

  const sortedJobTypes = useMemo(() => [...jobTypes].sort((a, b) => {
    if (a.name === 'Other') return 1
    if (b.name === 'Other') return -1
    return a.name.localeCompare(b.name)
  }), [jobTypes])

  const otherTypeId = useMemo(() => jobTypes.find(jt => jt.name === 'Other')?.id ?? '', [jobTypes])

  // Only single-item (or empty) jobs are editable inline; multi-item jobs show a link
  const editableJobs = jobs.filter(j => j.job_work_items.length <= 1)
  const complexJobs = jobs.filter(j => j.job_work_items.length > 1)

  const [drafts, setDrafts] = useState<Record<string, RowDraft>>(() =>
    Object.fromEntries(editableJobs.map(j => [j.id, initDraft(j, sortedJobTypes, otherTypeId)]))
  )

  function getJobType(id: string) { return jobTypes.find(jt => jt.id === id) }

  function updateDraft(jobId: string, patch: Partial<RowDraft>) {
    setDrafts(prev => ({ ...prev, [jobId]: { ...prev[jobId], ...patch, isDirty: true } }))
  }

  function handleTypeChange(jobId: string, jobTypeId: string) {
    if (jobTypeId === otherTypeId) {
      updateDraft(jobId, { jobTypeId, customDescription: '', customAmount: '' })
    } else {
      const jt = getJobType(jobTypeId)!
      const calculated_pay = calculateItemPay(jt.base_rate, jt.additional_rate, jt.requires_quantity, 1)
      updateDraft(jobId, { jobTypeId, quantity: 1, customDescription: '', customAmount: '', isDirty: true })
      // recalculate quietly
      setDrafts(prev => ({ ...prev, [jobId]: { ...prev[jobId], jobTypeId, quantity: 1, customDescription: '', customAmount: '', isDirty: true } }))
      void calculated_pay // suppress unused warning
    }
  }

  function handleQtyChange(jobId: string, quantity: number) {
    updateDraft(jobId, { quantity })
  }

  function calcPay(draft: RowDraft): number {
    if (draft.jobTypeId === otherTypeId) return parseFloat(draft.customAmount) || 0
    const jt = getJobType(draft.jobTypeId)
    if (!jt) return 0
    return calculateItemPay(jt.base_rate, jt.additional_rate, jt.requires_quantity, draft.quantity)
  }

  const dirtyCount = Object.values(drafts).filter(d => d.isDirty).length

  async function handleSaveAll() {
    setSaving(true)
    setSaveError('')
    setSavedCount(null)

    const supabase = createClient()
    const dirtyJobs = editableJobs.filter(j => drafts[j.id]?.isDirty)
    let saved = 0

    try {
      for (const job of dirtyJobs) {
        const draft = drafts[job.id]
        const isOther = draft.jobTypeId === otherTypeId

        if (isOther) {
          if (!draft.customDescription.trim() || !draft.customAmount || parseFloat(draft.customAmount) <= 0) continue
        }

        const jt = getJobType(draft.jobTypeId)
        if (!jt && !isOther) continue

        const calculated_pay = calcPay(draft)

        // Delete existing work items then insert new one
        await supabase.from('job_work_items').delete().eq('job_id', job.id)

        const { error: itemErr } = await supabase.from('job_work_items').insert({
          job_id: job.id,
          job_type_id: draft.jobTypeId,
          quantity: isOther ? 1 : draft.quantity,
          calculated_pay,
          custom_description: isOther ? draft.customDescription.trim() : null,
        })
        if (itemErr) throw new Error(itemErr.message)

        const { error: jobErr } = await supabase
          .from('jobs')
          .update({ total_pay: calculated_pay })
          .eq('id', job.id)
        if (jobErr) throw new Error(jobErr.message)

        saved++
      }

      // Mark all as clean
      setDrafts(prev => Object.fromEntries(
        Object.entries(prev).map(([id, d]) => [id, { ...d, isDirty: false }])
      ))
      setSavedCount(saved)
      router.refresh()
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href={`/tech?week=${selectedWeek}`} className="text-sm text-red-600 hover:underline">
          ← Back
        </Link>
        <div>
          <h1 className="text-xl font-bold text-gray-900">Bulk Update</h1>
          <p className="text-sm text-gray-500">{weekLabel(selectedWeek)}</p>
        </div>
      </div>

      {isLocked && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg px-4 py-3 text-sm text-yellow-800">
          This week is locked — no changes can be saved.
        </div>
      )}

      {jobs.length === 0 ? (
        <div className="text-center py-12 text-gray-400 text-sm">
          No jobs for this week. Sync from Service Fusion or add a job manually.
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          {/* Table header */}
          <div className="hidden sm:grid sm:grid-cols-[120px_1fr_200px_80px_80px] gap-3 px-4 py-2 bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
            <span>Date</span>
            <span>Job</span>
            <span>Work Type</span>
            <span>Qty / $</span>
            <span className="text-right">Pay</span>
          </div>

          {/* Editable rows */}
          {editableJobs.map((job, idx) => {
            const draft = drafts[job.id]
            if (!draft) return null
            const isOther = draft.jobTypeId === otherTypeId
            const jt = getJobType(draft.jobTypeId)
            const needsQty = !isOther && !!jt?.requires_quantity
            const pay = calcPay(draft)

            return (
              <div
                key={job.id}
                className={`px-4 py-3 sm:grid sm:grid-cols-[120px_1fr_200px_80px_80px] sm:gap-3 sm:items-start flex flex-col gap-2 ${idx % 2 === 0 ? '' : 'bg-gray-50'} ${draft.isDirty ? 'border-l-2 border-l-red-400' : ''} ${idx > 0 ? 'border-t border-gray-100' : ''}`}
              >
                {/* Date */}
                <div className="text-xs text-gray-500 pt-1 sm:pt-0.5 shrink-0">
                  {formatWorkDate(job.work_date)}
                </div>

                {/* Job name + badge */}
                <div className="flex items-start gap-2 min-w-0">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{job.job_name}</p>
                    <SFBadge source={job.source} sfStatus={job.sf_status} />
                  </div>
                </div>

                {/* Work type dropdown + extra fields */}
                <div className="space-y-1.5">
                  <select
                    disabled={isLocked}
                    value={draft.jobTypeId}
                    onChange={e => handleTypeChange(job.id, e.target.value)}
                    className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-400 disabled:opacity-50 disabled:bg-gray-100"
                  >
                    {sortedJobTypes.map(jt => (
                      <option key={jt.id} value={jt.id}>{jt.name}</option>
                    ))}
                  </select>
                  {isOther && (
                    <input
                      type="text"
                      disabled={isLocked}
                      placeholder="Description of work"
                      value={draft.customDescription}
                      onChange={e => updateDraft(job.id, { customDescription: e.target.value })}
                      className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-400 disabled:opacity-50"
                    />
                  )}
                </div>

                {/* Qty or custom amount */}
                <div>
                  {needsQty && (
                    <input
                      type="number"
                      min={1}
                      disabled={isLocked}
                      value={draft.quantity}
                      onChange={e => handleQtyChange(job.id, Math.max(1, parseInt(e.target.value) || 1))}
                      className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-400 disabled:opacity-50"
                    />
                  )}
                  {isOther && (
                    <div className="flex items-center gap-1">
                      <span className="text-sm text-gray-500">$</span>
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        disabled={isLocked}
                        placeholder="0.00"
                        value={draft.customAmount}
                        onChange={e => updateDraft(job.id, { customAmount: e.target.value })}
                        className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-400 disabled:opacity-50"
                      />
                    </div>
                  )}
                </div>

                {/* Pay */}
                <div className="text-right">
                  <span className={`text-sm font-semibold ${pay > 0 ? 'text-gray-900' : 'text-gray-400'}`}>
                    {formatMoney(pay)}
                  </span>
                </div>
              </div>
            )
          })}

          {/* Complex jobs (multiple work items) */}
          {complexJobs.length > 0 && (
            <>
              <div className="px-4 py-2 bg-gray-100 border-t border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Multiple work items — edit individually
              </div>
              {complexJobs.map((job, idx) => (
                <div
                  key={job.id}
                  className={`px-4 py-3 sm:grid sm:grid-cols-[120px_1fr_200px_80px_80px] sm:gap-3 sm:items-center flex flex-col gap-1 border-t border-gray-100 ${idx % 2 === 0 ? '' : 'bg-gray-50'}`}
                >
                  <div className="text-xs text-gray-500">{formatWorkDate(job.work_date)}</div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">{job.job_name}</p>
                    <p className="text-xs text-gray-400">{job.job_work_items.length} work items</p>
                  </div>
                  <div className="text-xs text-gray-400 italic">Use Edit for multiple items</div>
                  <div />
                  <div className="sm:text-right flex sm:flex-col gap-3 sm:gap-1 items-center sm:items-end">
                    <span className="text-sm font-semibold text-gray-900">{formatMoney(job.total_pay)}</span>
                    <Link href={`/tech/jobs/${job.id}/edit`} className="text-xs text-red-600 hover:underline">
                      Edit
                    </Link>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* Save footer */}
      {!isLocked && editableJobs.length > 0 && (
        <div className="sticky bottom-0 bg-gray-50 border-t border-gray-200 pt-4 space-y-2">
          {saveError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{saveError}</p>
          )}
          {savedCount !== null && (
            <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2">
              Saved {savedCount} job{savedCount !== 1 ? 's' : ''} successfully.
            </p>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-gray-500">
              {dirtyCount > 0 ? `${dirtyCount} unsaved change${dirtyCount !== 1 ? 's' : ''}` : 'No unsaved changes'}
            </span>
            <button
              onClick={handleSaveAll}
              disabled={saving || dirtyCount === 0}
              className="bg-red-600 text-white font-medium px-6 py-2 rounded-md text-sm hover:bg-red-700 disabled:opacity-40 transition-colors"
            >
              {saving ? 'Saving…' : 'Save All Changes'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function SFBadge({ source, sfStatus }: { source: string; sfStatus: string | null }) {
  if (source !== 'service_fusion') return null
  if (sfStatus === 'completed') {
    return <span className="text-xs text-green-700 font-medium">SF: Completed</span>
  }
  return <span className="text-xs text-yellow-700 font-medium">SF: Assigned</span>
}
