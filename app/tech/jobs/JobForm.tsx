'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { getWeekEnd, calculateItemPay, formatMoney, formatDate } from '@/lib/week'

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
  custom_description: string
  custom_amount: string  // string so the input is controlled cleanly
}

interface ExistingWorkItem {
  id: string
  job_type_id: string
  quantity: number
  calculated_pay: number
  custom_description: string | null
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
  source?: string      // 'service_fusion' locks job_name and work_date
  sfJobId?: string     // SF internal ID, used to build the link
  sfJobNumber?: string // SF display number e.g. "10042"
}

const SF_APP_BASE = 'https://app.servicefusion.com'

let tempIdCounter = 0
function newTempId() { return `tmp-${++tempIdCounter}` }

function makeWorkItemRow(jobType: JobType): WorkItemRow {
  return {
    tempId: newTempId(),
    job_type_id: jobType.id,
    quantity: 1,
    calculated_pay: calculateItemPay(jobType.base_rate, jobType.additional_rate, jobType.requires_quantity, 1),
    custom_description: '',
    custom_amount: '',
  }
}

export default function JobForm({ mode, weekStart, userId, jobTypes, existingJob, source, sfJobId, sfJobNumber }: Props) {
  const fromSF = source === 'service_fusion'
  const router = useRouter()
  const weekEnd = getWeekEnd(weekStart)

  // Sort job types: "Other" always last
  const sortedJobTypes = [...jobTypes].sort((a, b) => {
    if (a.name === 'Other') return 1
    if (b.name === 'Other') return -1
    return a.name.localeCompare(b.name)
  })

  const otherTypeId = jobTypes.find(jt => jt.name === 'Other')?.id ?? ''

  const [workDate, setWorkDate] = useState(existingJob?.work_date ?? formatDate(new Date()))
  const [jobName, setJobName] = useState(existingJob?.job_name ?? '')
  const [notes, setNotes] = useState(existingJob?.notes ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const [workItems, setWorkItems] = useState<WorkItemRow[]>(() => {
    if (existingJob && existingJob.job_work_items.length > 0) {
      return existingJob.job_work_items.map(item => {
        const isOther = item.job_type_id === otherTypeId
        return {
          tempId: newTempId(),
          job_type_id: item.job_type_id,
          quantity: item.quantity,
          calculated_pay: item.calculated_pay,
          custom_description: item.custom_description ?? '',
          custom_amount: isOther ? String(item.calculated_pay) : '',
        }
      })
    }
    if (sortedJobTypes.length > 0) {
      return [makeWorkItemRow(sortedJobTypes[0])]
    }
    return []
  })

  function getJobType(id: string) {
    return jobTypes.find(jt => jt.id === id)
  }

  function isOtherType(jobTypeId: string) {
    return jobTypeId === otherTypeId
  }

  function updateItemType(tempId: string, jobTypeId: string) {
    setWorkItems(items => items.map(item => {
      if (item.tempId !== tempId) return item
      if (isOtherType(jobTypeId)) {
        return { ...item, job_type_id: jobTypeId, calculated_pay: 0, custom_amount: '', custom_description: '' }
      }
      const jt = getJobType(jobTypeId)!
      return {
        ...item,
        job_type_id: jobTypeId,
        quantity: 1,
        calculated_pay: calculateItemPay(jt.base_rate, jt.additional_rate, jt.requires_quantity, 1),
        custom_description: '',
        custom_amount: '',
      }
    }))
  }

  function updateItemQty(tempId: string, quantity: number) {
    setWorkItems(items => items.map(item => {
      if (item.tempId !== tempId) return item
      const jt = getJobType(item.job_type_id)!
      return { ...item, quantity, calculated_pay: calculateItemPay(jt.base_rate, jt.additional_rate, jt.requires_quantity, quantity) }
    }))
  }

  function updateCustomDescription(tempId: string, value: string) {
    setWorkItems(items => items.map(item =>
      item.tempId === tempId ? { ...item, custom_description: value } : item
    ))
  }

  function updateCustomAmount(tempId: string, value: string) {
    const amount = parseFloat(value) || 0
    setWorkItems(items => items.map(item =>
      item.tempId === tempId ? { ...item, custom_amount: value, calculated_pay: amount } : item
    ))
  }

  function removeItem(tempId: string) {
    setWorkItems(items => items.filter(i => i.tempId !== tempId))
  }

  function addItem() {
    if (sortedJobTypes.length === 0) return
    setWorkItems(items => [...items, makeWorkItemRow(sortedJobTypes[0])])
  }

  const totalPay = workItems.reduce((s, i) => s + i.calculated_pay, 0)

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
    for (const item of workItems) {
      if (isOtherType(item.job_type_id)) {
        if (!item.custom_description.trim()) {
          setError('Please enter a description for the "Other" work item.')
          return
        }
        if (!item.custom_amount || parseFloat(item.custom_amount) <= 0) {
          setError('Please enter a valid amount for the "Other" work item.')
          return
        }
      }
    }

    setSaving(true)
    const supabase = createClient()

    try {
      const itemsPayload = workItems.map(i => ({
        job_type_id: i.job_type_id,
        quantity: i.quantity,
        calculated_pay: i.calculated_pay,
        custom_description: isOtherType(i.job_type_id) ? i.custom_description.trim() : null,
      }))

      if (mode === 'new') {
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
          itemsPayload.map(i => ({ ...i, job_id: job.id }))
        )
        if (itemErr) throw new Error(itemErr.message)

      } else if (mode === 'edit' && existingJob) {
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

        await supabase.from('job_work_items').delete().eq('job_id', existingJob.id)

        const { error: itemErr } = await supabase.from('job_work_items').insert(
          itemsPayload.map(i => ({ ...i, job_id: existingJob.id }))
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
          className="text-sm text-red-600 hover:underline"
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
          {fromSF ? (
            <p className="border border-gray-200 rounded-md px-3 py-2 text-base text-gray-500 bg-gray-50">
              {workDate}
            </p>
          ) : (
            <input
              type="date"
              required
              min={weekStart}
              max={weekEnd}
              value={workDate}
              onChange={e => setWorkDate(e.target.value)}
              className="border border-gray-300 rounded-md px-3 py-2 text-base text-gray-900 w-full focus:outline-none focus:ring-2 focus:ring-red-400"
            />
          )}
          {!fromSF && <p className="text-xs text-gray-400 mt-1">Must be within {weekStart} – {weekEnd}</p>}
        </div>

        {/* Job name / Customer */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {fromSF ? 'Customer (from Service Fusion)' : 'Job Name / PO'}
          </label>
          {fromSF ? (
            <p className="border border-gray-200 rounded-md px-3 py-2 text-base text-gray-500 bg-gray-50">
              {jobName}
            </p>
          ) : (
            <input
              type="text"
              required
              placeholder="e.g. Smith — 1234 Main St or PO 56789"
              value={jobName}
              onChange={e => setJobName(e.target.value)}
              className="border border-gray-300 rounded-md px-3 py-2 text-base text-gray-900 w-full focus:outline-none focus:ring-2 focus:ring-red-400"
            />
          )}
          {fromSF && (
            <p className="text-xs text-gray-400 mt-1">Pulled from Service Fusion — edit the job there to change this.</p>
          )}
        </div>

        {/* SF job link */}
        {fromSF && sfJobId && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Service Fusion Job</label>
            <a
              href={`${SF_APP_BASE}/jobs/${sfJobId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-red-600 hover:underline"
            >
              #{sfJobNumber ?? sfJobId} ↗
            </a>
            <p className="text-xs text-gray-400 mt-0.5">Opens in Service Fusion</p>
          </div>
        )}

        {/* Work items */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Work Items</label>
          <div className="space-y-3">
            {workItems.map(item => {
              const jt = getJobType(item.job_type_id)
              const isOther = isOtherType(item.job_type_id)
              return (
                <div key={item.tempId} className="flex gap-2 items-start">
                  <div className="flex-1 space-y-2">
                    <select
                      value={item.job_type_id}
                      onChange={e => updateItemType(item.tempId, e.target.value)}
                      className="border border-gray-300 rounded-md px-2 py-2 text-base text-gray-900 w-full focus:outline-none focus:ring-2 focus:ring-red-400"
                    >
                      {sortedJobTypes.map(jt => (
                        <option key={jt.id} value={jt.id}>{jt.name}</option>
                      ))}
                    </select>

                    {isOther && (
                      <div className="space-y-2">
                        <input
                          type="text"
                          placeholder="Description of work"
                          value={item.custom_description}
                          onChange={e => updateCustomDescription(item.tempId, e.target.value)}
                          className="border border-gray-300 rounded-md px-2 py-2 text-base text-gray-900 w-full focus:outline-none focus:ring-2 focus:ring-red-400"
                        />
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-gray-500">$</span>
                          <input
                            type="number"
                            min={0}
                            step={0.01}
                            placeholder="0.00"
                            value={item.custom_amount}
                            onChange={e => updateCustomAmount(item.tempId, e.target.value)}
                            className="border border-gray-300 rounded-md px-2 py-2 text-base text-gray-900 w-32 focus:outline-none focus:ring-2 focus:ring-red-400"
                          />
                        </div>
                      </div>
                    )}

                    {!isOther && jt?.requires_quantity && (
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-gray-500 whitespace-nowrap">Qty:</label>
                        <input
                          type="number"
                          min={1}
                          value={item.quantity}
                          onChange={e => updateItemQty(item.tempId, Math.max(1, parseInt(e.target.value) || 1))}
                          className="border border-gray-300 rounded-md px-2 py-1 text-base text-gray-900 w-20 focus:outline-none focus:ring-2 focus:ring-red-400"
                        />
                      </div>
                    )}
                  </div>

                  {!isOther && (
                    <div className="text-right shrink-0 pt-2">
                      <span className="text-sm font-semibold text-gray-800">{formatMoney(item.calculated_pay)}</span>
                    </div>
                  )}

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
            className="mt-3 text-sm text-red-600 hover:underline"
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
            className="border border-gray-300 rounded-md px-3 py-2 text-base text-gray-900 w-full focus:outline-none focus:ring-2 focus:ring-red-400"
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
            className="flex-1 bg-red-600 text-white rounded-md py-2 text-sm hover:bg-red-600 disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save Job'}
          </button>
        </div>
      </form>
    </div>
  )
}
