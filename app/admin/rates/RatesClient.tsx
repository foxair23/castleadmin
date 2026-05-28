'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { formatMoney } from '@/lib/week'

interface JobType {
  id: string
  name: string
  base_rate: number
  additional_rate: number | null
  requires_quantity: boolean
  requires_sale_amount: boolean
  is_active: boolean
}

interface FormState {
  name: string
  base_rate: string
  additional_rate: string
  requires_quantity: boolean
  is_active: boolean
}

function emptyForm(): FormState {
  return { name: '', base_rate: '', additional_rate: '', requires_quantity: false, is_active: true }
}

function jobTypeToForm(jt: JobType): FormState {
  return {
    name: jt.name,
    base_rate: String(jt.base_rate),
    additional_rate: jt.additional_rate != null ? String(jt.additional_rate) : '',
    requires_quantity: jt.requires_quantity,
    is_active: jt.is_active,
  }
}

export default function RatesClient({ initialJobTypes }: { initialJobTypes: JobType[] }) {
  const router = useRouter()
  const [jobTypes, setJobTypes] = useState(initialJobTypes)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showNewForm, setShowNewForm] = useState(false)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [deleteError, setDeleteError] = useState('')

  function startEdit(jt: JobType) {
    setEditingId(jt.id)
    setForm(jobTypeToForm(jt))
    setShowNewForm(false)
    setError('')
  }

  function startNew() {
    setEditingId(null)
    setForm(emptyForm())
    setShowNewForm(true)
    setError('')
  }

  function cancelEdit() {
    setEditingId(null)
    setShowNewForm(false)
    setError('')
  }

  async function handleSave() {
    setError('')
    const base = parseFloat(form.base_rate)
    if (!form.name.trim() || isNaN(base) || base < 0) {
      setError('Name and valid base rate are required.')
      return
    }
    const additional = form.requires_quantity && form.additional_rate
      ? parseFloat(form.additional_rate)
      : null

    setSaving(true)
    const supabase = createClient()

    const payload = {
      name: form.name.trim(),
      base_rate: base,
      additional_rate: additional,
      requires_quantity: form.requires_quantity,
      is_active: form.is_active,
    }

    try {
      if (editingId) {
        const { data, error: err } = await supabase
          .from('job_types')
          .update(payload)
          .eq('id', editingId)
          .select()
          .single()
        if (err) throw err
        setJobTypes(jts => jts.map(jt => jt.id === editingId ? data : jt))
        setEditingId(null)
      } else {
        const { data, error: err } = await supabase
          .from('job_types')
          .insert(payload)
          .select()
          .single()
        if (err) throw err
        setJobTypes(jts => [...jts, data].sort((a, b) => a.name.localeCompare(b.name)))
        setShowNewForm(false)
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(jt: JobType) {
    if (!confirm(`Delete "${jt.name}"? This cannot be undone.`)) return
    setDeleteError('')
    const supabase = createClient()
    const { error: err } = await supabase.from('job_types').delete().eq('id', jt.id)
    if (err) {
      if (err.code === '23503') {
        setDeleteError(`"${jt.name}" can't be deleted because it's referenced by existing pay records. Set it to Inactive instead.`)
      } else {
        setDeleteError(err.message)
      }
      return
    }
    setJobTypes(jts => jts.filter(j => j.id !== jt.id))
    if (editingId === jt.id) setEditingId(null)
  }

  async function handleToggleActive(jt: JobType) {
    const supabase = createClient()
    const { data, error: err } = await supabase
      .from('job_types')
      .update({ is_active: !jt.is_active })
      .eq('id', jt.id)
      .select()
      .single()
    if (!err && data) {
      setJobTypes(jts => jts.map(j => j.id === jt.id ? data : j))
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">Pay Rates</h1>
        <button
          onClick={startNew}
          className="bg-red-600 hover:bg-red-600 text-white text-sm font-medium px-4 py-2 rounded-md transition-colors"
        >
          + Add Job Type
        </button>
      </div>

      {/* New job type form */}
      {showNewForm && (
        <div className="bg-white border border-red-200 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-gray-800 mb-3">New Job Type</h2>
          <RateForm form={form} setForm={setForm} error={error} saving={saving} onSave={handleSave} onCancel={cancelEdit} />
        </div>
      )}

      {deleteError && (
        <div className="flex items-start justify-between gap-3 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
          <span>{deleteError}</span>
          <button onClick={() => setDeleteError('')} className="text-red-400 hover:text-red-600 shrink-0">✕</button>
        </div>
      )}

      {/* Table */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-3 font-medium text-gray-600">Job Type</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Base Rate</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600 hidden sm:table-cell">+Rate</th>
                <th className="text-center px-4 py-3 font-medium text-gray-600 hidden sm:table-cell">Qty?</th>
                <th className="text-center px-4 py-3 font-medium text-gray-600">Active</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {jobTypes.map(jt => (
                <>
                  <tr key={jt.id} className={jt.is_active ? '' : 'opacity-50'}>
                    <td className="px-4 py-3 text-gray-900">{jt.name}</td>
                    <td className="px-4 py-3 text-right text-gray-700">{formatMoney(jt.base_rate)}</td>
                    <td className="px-4 py-3 text-right text-gray-500 hidden sm:table-cell">
                      {jt.additional_rate != null ? formatMoney(jt.additional_rate) : '—'}
                    </td>
                    <td className="px-4 py-3 text-center hidden sm:table-cell">
                      {jt.requires_quantity ? '✓' : ''}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={() => handleToggleActive(jt)}
                        className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          jt.is_active
                            ? 'bg-green-100 text-green-700 hover:bg-green-200'
                            : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                        }`}
                      >
                        {jt.is_active ? 'Active' : 'Inactive'}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-3">
                        <button
                          onClick={() => startEdit(jt)}
                          className="text-red-600 hover:underline text-xs"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDelete(jt)}
                          className="text-red-500 hover:underline text-xs"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                  {editingId === jt.id && (
                    <tr key={`${jt.id}-edit`}>
                      <td colSpan={6} className="bg-red-50 px-4 py-4">
                        <RateForm form={form} setForm={setForm} error={error} saving={saving} onSave={handleSave} onCancel={cancelEdit} />
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function RateForm({
  form,
  setForm,
  error,
  saving,
  onSave,
  onCancel,
}: {
  form: FormState
  setForm: (f: FormState) => void
  error: string
  saving: boolean
  onSave: () => void
  onCancel: () => void
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Name</label>
          <input
            type="text"
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            className="border border-gray-300 rounded px-2 py-1.5 text-base text-gray-900 w-full focus:outline-none focus:ring-2 focus:ring-red-400"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Base Rate ($)</label>
          <input
            type="number"
            min={0}
            step={0.01}
            value={form.base_rate}
            onChange={e => setForm({ ...form, base_rate: e.target.value })}
            className="border border-gray-300 rounded px-2 py-1.5 text-base text-gray-900 w-full focus:outline-none focus:ring-2 focus:ring-red-400"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={form.requires_quantity}
            onChange={e => setForm({ ...form, requires_quantity: e.target.checked })}
            className="w-4 h-4"
          />
          <span className="text-gray-700">Requires quantity</span>
        </label>

        {form.requires_quantity && (
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-600">Additional rate ($):</label>
            <input
              type="number"
              min={0}
              step={0.01}
              value={form.additional_rate}
              onChange={e => setForm({ ...form, additional_rate: e.target.value })}
              className="border border-gray-300 rounded px-2 py-1.5 text-base text-gray-900 w-24 focus:outline-none focus:ring-2 focus:ring-red-400"
            />
          </div>
        )}
      </div>

      <div>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={form.is_active}
            onChange={e => setForm({ ...form, is_active: e.target.checked })}
            className="w-4 h-4"
          />
          <span className="text-gray-700">Active (visible to technicians)</span>
        </label>
      </div>

      {error && (
        <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5">{error}</p>
      )}

      <div className="flex gap-2">
        <button
          onClick={onCancel}
          className="border border-gray-300 text-gray-600 rounded px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          onClick={onSave}
          disabled={saving}
          className="bg-red-600 text-white rounded px-3 py-1.5 text-sm hover:bg-red-600 disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}
