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
  requires_sale_amount: boolean
}

interface WorkItemRow {
  tempId: string
  job_type_id: string
  quantity: number
  calculated_pay: number
  custom_description: string
  custom_amount: string  // string so the input is controlled cleanly
  job_type_name: string
  locked_base_rate: number
  locked_additional_rate: number | null
  locked_requires_quantity: boolean
}

interface ExistingWorkItem {
  id: string
  job_type_id: string
  quantity: number
  calculated_pay: number
  custom_description: string | null
  job_type_name: string | null
  locked_base_rate: number | null
  locked_additional_rate: number | null
  locked_requires_quantity: boolean | null
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
  gasEligible?: boolean
  existingJob?: ExistingJob
  source?: string      // 'service_fusion' locks job_name and work_date
  sfJobId?: string     // SF internal ID, used to build the link
  sfJobNumber?: string // SF display number e.g. "10042"
}

const SF_JOBS_URL = 'https://admin.servicefusion.com/jobs'

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
    job_type_name: jobType.name,
    locked_base_rate: jobType.base_rate,
    locked_additional_rate: jobType.additional_rate,
    locked_requires_quantity: jobType.requires_quantity,
  }
}

const GAS_AMOUNT = 20

export default function JobForm({ mode, weekStart, userId, jobTypes, gasEligible, existingJob, source, sfJobId, sfJobNumber }: Props) {
  const fromSF = source === 'service_fusion'
  const router = useRouter()
  const weekEnd = getWeekEnd(weekStart)

  // Sort job types: custom-input types (Other, Sale Commission) always last
  const sortedJobTypes = [...jobTypes].sort((a, b) => {
    const aLast = a.name === 'Other' || a.requires_sale_amount
    const bLast = b.name === 'Other' || b.requires_sale_amount
    if (aLast && !bLast) return 1
    if (!aLast && bLast) return -1
    return a.name.localeCompare(b.name)
  })

  const otherTypeId = jobTypes.find(jt => jt.name === 'Other')?.id ?? ''

  const [workDate, setWorkDate] = useState(existingJob?.work_date ?? formatDate(new Date()))
  const [jobName, setJobName] = useState(existingJob?.job_name ?? '')
  const [notes, setNotes] = useState(existingJob?.notes ?? '')
  const [gasPaid, setGasPaid] = useState<boolean>((existingJob as (ExistingJob & { gas_paid?: boolean }) | undefined)?.gas_paid ?? false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const [workItems, setWorkItems] = useState<WorkItemRow[]>(() => {
    if (existingJob && existingJob.job_work_items.length > 0) {
      return existingJob.job_work_items.map(item => {
        const jt = jobTypes.find(j => j.id === item.job_type_id)
        const isOther = item.job_type_id === otherTypeId
        const isSaleCommission = jt?.requires_sale_amount ?? false
        return {
          tempId: newTempId(),
          job_type_id: item.job_type_id,
          quantity: item.quantity,
          calculated_pay: item.calculated_pay,
          custom_description: item.custom_description ?? '',
          custom_amount: (isOther || isSaleCommission) ? String(item.calculated_pay) : '',
          job_type_name: item.job_type_name ?? jt?.name ?? '',
          locked_base_rate: item.locked_base_rate ?? jt?.base_rate ?? 0,
          locked_additional_rate: item.locked_additional_rate ?? jt?.additional_rate ?? null,
          locked_requires_quantity: item.locked_requires_quantity ?? jt?.requires_quantity ?? false,
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

  function isSaleCommissionType(jobTypeId: string) {
    return !!getJobType(jobTypeId)?.requires_sale_amount
  }

  function updateItemType(tempId: string, jobTypeId: string) {
    setWorkItems(items => items.map(item => {
      if (item.tempId !== tempId) return item
      const jt = getJobType(jobTypeId)
      const locked = {
        job_type_name: jt?.name ?? '',
        locked_base_rate: jt?.base_rate ?? 0,
        locked_additional_rate: jt?.additional_rate ?? null,
        locked_requires_quantity: jt?.requires_quantity ?? false,
      }
      if (isOtherType(jobTypeId) || isSaleCommissionType(jobTypeId)) {
        return { ...item, job_type_id: jobTypeId, calculated_pay: 0, custom_amount: '', custom_description: '', ...locked }
      }
      return {
        ...item,
        ...locked,
        job_type_id: jobTypeId,
        quantity: 1,
        calculated_pay: calculateItemPay(jt!.base_rate, jt!.additional_rate, jt!.requires_quantity, 1),
        custom_description: '',
        custom_amount: '',
      }
    }))
  }

  function updateItemQty(tempId: string, quantity: number) {
    setWorkItems(items => items.map(item => {
      if (item.tempId !== tempId) return item
      const jt = getJobType(item.job_type_id)
      return {
        ...item,
        quantity,
        calculated_pay: calculateItemPay(
          item.locked_base_rate ?? jt?.base_rate ?? 0,
          item.locked_additional_rate ?? jt?.additional_rate ?? null,
          item.locked_requires_quantity ?? jt?.requires_quantity ?? false,
          quantity,
        ),
      }
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

  const totalPay = workItems.reduce((s, i) => s + i.calculated_pay, 0) + (gasPaid ? GAS_AMOUNT : 0)

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setError('')

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
      if (isSaleCommissionType(item.job_type_id)) {
        if (!item.custom_description.trim() || parseFloat(item.custom_description) <= 0) {
          setError('Please enter the sale amount for the "New Sale Commission" item.')
          return
        }
        if (!item.custom_amount || parseFloat(item.custom_amount) <= 0) {
          setError('Please enter the commission amount for the "New Sale Commission" item.')
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
        job_type_name: i.job_type_name || null,
        locked_base_rate: i.locked_base_rate,
        locked_additional_rate: i.locked_additional_rate,
        locked_requires_quantity: i.locked_requires_quantity,
        custom_description: (isOtherType(i.job_type_id) || isSaleCommissionType(i.job_type_id))
          ? i.custom_description.trim()
          : null,
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
            gas_paid: gasEligible ? gasPaid : false,
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
            gas_paid: gasEligible ? gasPaid : false,
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
        {fromSF && sfJobNumber && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Service Fusion Job</label>
            <a
              href={SF_JOBS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-red-600 hover:underline"
            >
              #{sfJobNumber} ↗
            </a>
            <p className="text-xs text-gray-400 mt-0.5">Opens Service Fusion jobs — search for #{sfJobNumber}</p>
          </div>
        )}

        {/* Work items */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Work Items</label>
          <div className="space-y-3">
            {workItems.map(item => {
              const jt = getJobType(item.job_type_id)
              const isOther = isOtherType(item.job_type_id)
              const isSaleCommission = isSaleCommissionType(item.job_type_id)
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

                    {isSaleCommission && (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <label className="text-xs text-gray-500 whitespace-nowrap w-28">Sale Amount ($)</label>
                          <input
                            type="number"
                            min={0}
                            step={0.01}
                            placeholder="0.00"
                            value={item.custom_description}
                            onChange={e => updateCustomDescription(item.tempId, e.target.value)}
                            className="border border-gray-300 rounded-md px-2 py-2 text-base text-gray-900 w-36 focus:outline-none focus:ring-2 focus:ring-red-400"
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <label className="text-xs text-gray-500 whitespace-nowrap w-28">Commission Pay ($)</label>
                          <input
                            type="number"
                            min={0}
                            step={0.01}
                            placeholder="0.00"
                            value={item.custom_amount}
                            onChange={e => updateCustomAmount(item.tempId, e.target.value)}
                            className="border border-gray-300 rounded-md px-2 py-2 text-base text-gray-900 w-36 focus:outline-none focus:ring-2 focus:ring-red-400"
                          />
                        </div>
                      </div>
                    )}

                    {!isOther && !isSaleCommission && jt?.requires_quantity && (
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

                  {!isOther && !isSaleCommission && (
                    <div className="text-right shrink-0 pt-2">
                      <span className="text-sm font-semibold text-gray-800">{formatMoney(item.calculated_pay)}</span>
                    </div>
                  )}

                  <button
                      type="button"
                      onClick={() => removeItem(item.tempId)}
                      className="text-red-400 hover:text-red-600 pt-2 text-lg leading-none"
                      title="Remove"
                    >
                      ×
                    </button>
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

        {/* Gas reimbursement */}
        {gasEligible && (
          <div className="flex items-center gap-3 p-3 bg-amber-50 border border-amber-200 rounded-md">
            <input
              id="gas-paid"
              type="checkbox"
              checked={gasPaid}
              onChange={e => setGasPaid(e.target.checked)}
              className="w-4 h-4 accent-amber-500"
            />
            <label htmlFor="gas-paid" className="text-sm text-gray-700 cursor-pointer select-none">
              Gas reimbursement — <span className="font-semibold">+{formatMoney(GAS_AMOUNT)}</span>
            </label>
          </div>
        )}

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
