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
  requires_sale_amount: boolean
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
  isDirty: boolean
}

interface Props {
  selectedWeek: string
  jobs: Job[]
  jobTypes: JobType[]
  isLocked: boolean
}

function formatWorkDate(dateStr: string) {
  return parseDate(dateStr).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

export default function BulkUpdateClient({ selectedWeek, jobs, jobTypes, isLocked }: Props) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [savedCount, setSavedCount] = useState<number | null>(null)

  const customTypeIds = useMemo(() =>
    new Set(jobTypes.filter(jt => jt.name === 'Other' || jt.requires_sale_amount).map(jt => jt.id)),
    [jobTypes]
  )

  const inlineJobTypes = useMemo(() =>
    [...jobTypes].sort((a, b) => {
      const aCustom = a.name === 'Other' || a.requires_sale_amount
      const bCustom = b.name === 'Other' || b.requires_sale_amount
      if (aCustom && !bCustom) return 1
      if (!aCustom && bCustom) return -1
      return a.name.localeCompare(b.name)
    }),
    [jobTypes]
  )

  // Only jobs with 2+ work items need the full edit page
  const editableJobs = jobs.filter(j => j.job_work_items.length <= 1)
  const manualJobs = jobs.filter(j => j.job_work_items.length > 1)

  const [drafts, setDrafts] = useState<Record<string, RowDraft>>(() =>
    Object.fromEntries(editableJobs.map(j => {
      const existing = j.job_work_items[0]
      return [j.id, {
        jobTypeId: existing?.job_type_id ?? '',  // '' = nothing selected
        isDirty: false,
      }]
    }))
  )

  function getJobType(id: string) { return jobTypes.find(jt => jt.id === id) }

  function calcPay(jobTypeId: string): number {
    const jt = getJobType(jobTypeId)
    if (!jt) return 0
    return calculateItemPay(jt.base_rate, jt.additional_rate, jt.requires_quantity, 1)
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
        const { jobTypeId } = drafts[job.id]
        if (!jobTypeId) {
          // Cleared back to unset — remove any existing work item
          await supabase.from('job_work_items').delete().eq('job_id', job.id)
          await supabase.from('jobs').update({ total_pay: 0 }).eq('id', job.id)
          saved++
          continue
        }
        const jt = getJobType(jobTypeId)
        if (!jt) continue

        // Custom types (Other, New Sale Commission) need details filled in on the edit page
        const isCustomType = customTypeIds.has(jobTypeId)
        const calculated_pay = isCustomType ? 0 : calcPay(jobTypeId)

        await supabase.from('job_work_items').delete().eq('job_id', job.id)

        const { error: itemErr } = await supabase.from('job_work_items').insert({
          job_id: job.id,
          job_type_id: jobTypeId,
          quantity: 1,
          calculated_pay,
          custom_description: null,
        })
        if (itemErr) throw new Error(itemErr.message)

        const { error: jobErr } = await supabase
          .from('jobs')
          .update({ total_pay: calculated_pay })
          .eq('id', job.id)
        if (jobErr) throw new Error(jobErr.message)

        saved++
      }

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
          <h1 className="text-xl font-bold text-gray-900">Bulk Edit</h1>
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
          <div className="hidden sm:grid sm:grid-cols-[130px_1fr_220px_80px] gap-3 px-4 py-2 bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
            <span>Date</span>
            <span>Job</span>
            <span>Work Type</span>
            <span className="text-right">Pay</span>
          </div>

          {/* Editable rows */}
          {editableJobs.map((job, idx) => {
            const draft = drafts[job.id]
            if (!draft) return null
            const pay = calcPay(draft.jobTypeId)

            return (
              <div
                key={job.id}
                className={`px-4 py-3 sm:grid sm:grid-cols-[130px_1fr_220px_80px] sm:gap-3 sm:items-center flex flex-col gap-2 ${idx > 0 ? 'border-t border-gray-100' : ''} ${idx % 2 !== 0 ? 'bg-gray-50' : ''} ${draft.isDirty ? 'border-l-2 border-l-red-400' : ''}`}
              >
                <div className="text-xs text-gray-500 shrink-0">
                  {formatWorkDate(job.work_date)}
                </div>

                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{job.job_name}</p>
                  <SFBadge source={job.source} sfStatus={job.sf_status} />
                </div>

                <div>
                  <select
                    disabled={isLocked}
                    value={draft.jobTypeId}
                    onChange={e => setDrafts(prev => ({ ...prev, [job.id]: { jobTypeId: e.target.value, isDirty: true } }))}
                    className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-400 disabled:opacity-50 disabled:bg-gray-100 text-gray-900"
                  >
                    <option value="" className="text-gray-400">— Select work type —</option>
                    {inlineJobTypes.map(jt => (
                      <option key={jt.id} value={jt.id}>{jt.name}</option>
                    ))}
                  </select>
                  {customTypeIds.has(draft.jobTypeId) && (
                    <p className="text-xs text-amber-600 mt-1">Edit job to add required details</p>
                  )}
                </div>

                <div className="text-right">
                  <span className={`text-sm font-semibold ${pay > 0 ? 'text-gray-900' : 'text-gray-400'}`}>
                    {formatMoney(pay)}
                  </span>
                </div>
              </div>
            )
          })}

          {/* Jobs that need the full edit page (2+ work items) */}
          {manualJobs.length > 0 && (
            <>
              <div className="px-4 py-2 bg-gray-100 border-t border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Multiple work items — edit individually
              </div>
              {manualJobs.map((job, idx) => (
                <div
                  key={job.id}
                  className={`px-4 py-3 sm:grid sm:grid-cols-[130px_1fr_220px_80px] sm:gap-3 sm:items-center flex flex-col gap-1 border-t border-gray-100 ${idx % 2 !== 0 ? 'bg-gray-50' : ''}`}
                >
                  <div className="text-xs text-gray-500">{formatWorkDate(job.work_date)}</div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">{job.job_name}</p>
                    <p className="text-xs text-gray-400">{job.job_work_items.length} work items</p>
                  </div>
                  <div className="text-xs text-gray-400 italic sm:block hidden">Requires full edit</div>
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
