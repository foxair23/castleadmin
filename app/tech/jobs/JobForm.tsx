'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { getWeekEnd, calculateItemPay, formatMoney, formatDate, parseDate } from '@/lib/week'

interface JobType {
  id: string
  name: string
  base_rate: number
  additional_rate: number | null
  requires_quantity: boolean
}

interface WorkItemRow {
  tempId: string
  job_type_id: string
  quantity: number
  calculated_pay: number
}

interface ExistingWorkItem {
  id: string
  job_type_id: string
  quantity: number
  calculated_pay: number
}

interface ExistingJob {
  id: string
  work_date: string
  job_name: string
  notes: string | null
  total_pay: number
  week_start_date: string
  job_work_items: ExistingWorkItem[]
}

interface Props {
  mode: 'new' | 'edit'
  weekStart: string
  userId: string
  jobTypes: JobType[]
  existingJob?: ExistingJob
}

let tempIdCounter = 0
function newTempId() { return `tmp-${++tempIdCounter}` }

function makeWorkItemRow(jobType: JobType): WorkItemRow {
  return {
    tempId: newTempId(),
    job_type_id: jobType.id,
    quantity: 1,
    calculated_pay: calculateItemPay(jobType.base_rate, jobType.additional_rate, jobType.requires_quantity, 1),
  }
}

export default function JobForm({ mode, weekStart, userId, jobTypes, existingJob }: Props) {
  const router = useRouter()
  const weekEnd = getWeekEnd(weekStart)

  const [workDate, setWorkDate] = useState(existingJob?.work_date ?? formatDate(new Date()))
  const [jobName, setJobName] = useState(existingJob?.job_name ?? '')
  const [notes, setNotes] = useState(existingJob?.notes ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const [workItems, setWorkItems] = useState<WorkItemRow[]>(() => {
    if (existingJob && existingJob.job_work_items.length > 0) {
      return existingJob.job_work_items.map(item => ({
        tempId: newTempId(),
        job_type_id: item.job_type_id,
        quantity: item.quantity,
        calculated_pay: item.calculated_pay,
      }))
    }
    // Default: one empty work item row using first job type
    if (jobTypes.length > 0) {
      return [makeWorkItemRow(jobTypes[0])]
    }
    return []
  })

  function getJobType(id: string) {
    return jobTypes.find(jt => jt.id === id)
  }

  function recalcItem(item: WorkItemRow, jobTypeId: string, quantity: number): WorkItemRow {
    const jt = getJobType(jobTypeId)
    if (!jt) return item
    return {
      ...item,
      job_type_id: jobTypeId,
      quantity,
      calculated_pay: calculateItemPay(jt.base_rate, jt.additional_rate, jt.requires_quantity, quantity),
    }
  }

  function updateItemType(tempId: string, jobTypeId: string) {
    setWorkItems(items =>
      items.map(item => item.tempId === tempId ? recalcItem(item, jobTypeId, item.quantity) : item)
    )
  }

  function updateItemQty(tempId: string, quantity: number) {
    setWorkItems(items =>
      items.map(item => item.tempId === tempId ? recalcItem(item, item.job_type_id, quantity) : item)
    )
  }

  function removeItem(tempId: string) {
    setWorkItems(items => items.filter(i => i.tempId !== tempId))
  }

  function addItem() {
    if (jobTypes.length === 0) return
    setWorkItems(items => [...items, makeWorkItemRow(jobTypes[0])])
  }

  const totalPay = workItems.reduce((s, i) => s + i.calculated_pay, 0)

  // Clamp date to within workweek
  const minDate = weekStart
  const maxDate = weekEnd

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (workItems.length === 0) {
      setError('Add at least one work item.')
      return
    }
    if (!jobName.trim()) {
      setError('Job name / PO is required.')
      return
    }

    setSaving(true)
    const supabase = createClient()

    try {
      if (mode === 'new') {
        // Insert job
        const { data: job, error: jobErr } = await supabase
          .from('jobs')
          .insert({
            tech_id: userId,
            work_date: workDate,
            job_name: jobName.trim(),
            notes: notes.trim() || null,
            total_pay: totalPay,
            week_start_date: weekStart,
          })
          .select('id')
          .single()

        if (jobErr || !job) throw new Error(jobErr?.message ?? 'Failed to save job')

        const { error: itemErr } = await supabase.from('job_work_items').insert(
          workItems.map(i => ({
            job_id: job.id,
            job_type_id: i.job_type_id,
            quantity: i.quantity,
            calculated_pay: i.calculated_pay,
          }))
        )
        if (itemErr) throw new Error(itemErr.message)

      } else if (mode === 'edit' && existingJob) {
        // Update job
        const { error: jobErr } = await supabase
          .from('jobs')
          .update({
            work_date: workDate,
            job_name: jobName.trim(),
            notes: notes.trim() || null,
            total_pay: totalPay,
          })
          .eq('id', existingJob.id)

        if (jobErr) throw new Error(jobErr.message)

        // Replace all work items
        await supabase.from('job_work_items').delete().eq('job_id', existingJob.id)

        const { error: itemErr } = await supabase.from('job_work_items').insert(
          workItems.map(i => ({
            job_id: existingJob.id,
            job_type_id: i.job_type_id,
            quantity: i.quantity,
            calculated_pay: i.calculated_pay,
          }))
        )
        if (itemErr) throw new Error(itemErr.message)
      }

      router.push(`/tech?week=${weekStart}`)
      router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'An error occurred')
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button
          onClick={() => router.push(`/tech?week=${weekStart}`)}
          className="text-sm text-blue-600 hover:underline"
        >
          ← Back
        </button>
        <h1 className="text-xl font-bold text-gray-900">
          {mode === 'new' ? 'Add Job' : 'Edit Job'}
        </h1>
      </div>

      <form onSubmit={handleSave} className="bg-white border border-gray-200 rounded-lg p-5 space-y-5">
        {/* Date */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
          <input
            type="date"
            required
            min={minDate}
            max={maxDate}
            value={workDate}
            onChange={e => setWorkDate(e.target.value)}
            className="border border-gray-300 rounded-md px-3 py-2 text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-xs text-gray-400 mt-1">Must be within {weekStart} – {weekEnd}</p>
        </div>

        {/* Job name / PO */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Job Name / PO</label>
          <input
            type="text"
            required
            placeholder="e.g. Smith — 1234 Main St or PO 56789"
            value={jobName}
            onChange={e => setJobName(e.target.value)}
            className="border border-gray-300 rounded-md px-3 py-2 text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Work items */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Work Items</label>
          <div className="space-y-3">
            {workItems.map((item, idx) => {
              const jt = getJobType(item.job_type_id)
              return (
                <div key={item.tempId} className="flex gap-2 items-start">
                  <div className="flex-1 space-y-2">
                    <select
                      value={item.job_type_id}
                      onChange={e => updateItemType(item.tempId, e.target.value)}
                      className="border border-gray-300 rounded-md px-2 py-2 text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      {jobTypes.map(jt => (
                        <option key={jt.id} value={jt.id}>{jt.name}</option>
                      ))}
                    </select>
                    {jt?.requires_quantity && (
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-gray-500 whitespace-nowrap">Qty:</label>
                        <input
                          type="number"
                          min={1}
                          value={item.quantity}
                          onChange={e => updateItemQty(item.tempId, Math.max(1, parseInt(e.target.value) || 1))}
                          className="border border-gray-300 rounded-md px-2 py-1 text-sm w-20 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                    )}
                  </div>
                  <div className="text-right shrink-0 pt-2">
                    <span className="text-sm font-semibold text-gray-800">{formatMoney(item.calculated_pay)}</span>
                  </div>
                  {workItems.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeItem(item.tempId)}
                      className="text-red-400 hover:text-red-600 pt-2 text-lg leading-none"
                      title="Remove"
                    >
                      ×
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          <button
            type="button"
            onClick={addItem}
            className="mt-3 text-sm text-blue-600 hover:underline"
          >
            + Add another work item
          </button>
        </div>

        {/* Notes */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Notes (optional)</label>
          <textarea
            rows={2}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Any additional notes…"
            className="border border-gray-300 rounded-md px-3 py-2 text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Total */}
        <div className="flex justify-between items-center border-t pt-3">
          <span className="text-sm font-medium text-gray-700">Job Total</span>
          <span className="text-lg font-bold text-gray-900">{formatMoney(totalPay)}</span>
        </div>

        {error && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
            {error}
          </p>
        )}

        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => router.push(`/tech?week=${weekStart}`)}
            className="flex-1 border border-gray-300 text-gray-700 rounded-md py-2 text-sm hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="flex-1 bg-blue-600 text-white rounded-md py-2 text-sm hover:bg-blue-700 disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save Job'}
          </button>
        </div>
      </form>
    </div>
  )
}
