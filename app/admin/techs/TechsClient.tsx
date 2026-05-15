'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'

interface Tech {
  id: string
  full_name: string
  email: string
  role: string
  is_active: boolean
  created_at: string
  weekly_bonus: number
}

interface NewTechForm {
  full_name: string
  email: string
  password: string
}

export default function TechsClient({ initialTechs }: { initialTechs: Tech[] }) {
  const [techs, setTechs] = useState(initialTechs)
  const [showNewForm, setShowNewForm] = useState(false)
  const [form, setForm] = useState<NewTechForm>({ full_name: '', email: '', password: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [resetingId, setResetingId] = useState<string | null>(null)
  const [resetForm, setResetForm] = useState<Record<string, string>>({})
  const [emailingId, setEmailingId] = useState<string | null>(null)
  const [emailForm, setEmailForm] = useState<Record<string, string>>({})
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [bonusId, setBonusId] = useState<string | null>(null)
  const [bonusForm, setBonusForm] = useState<Record<string, string>>({})

  async function handleCreateTech(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setSuccess('')

    if (!form.full_name.trim() || !form.email.trim() || !form.password.trim()) {
      setError('All fields are required.')
      return
    }
    if (form.password.length < 6) {
      setError('Password must be at least 6 characters.')
      return
    }

    setSaving(true)
    const res = await fetch('/api/admin/techs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        full_name: form.full_name.trim(),
        email: form.email.trim(),
        password: form.password,
      }),
    })

    const data = await res.json()
    if (!res.ok) {
      setError(data.error ?? 'Failed to create technician')
    } else {
      setTechs(t => [...t, data.profile].sort((a, b) => a.full_name.localeCompare(b.full_name)))
      setForm({ full_name: '', email: '', password: '' })
      setShowNewForm(false)
      setSuccess(`Technician "${data.profile.full_name}" created successfully.`)
    }
    setSaving(false)
  }

  async function handleToggleActive(tech: Tech) {
    setTogglingId(tech.id)
    const res = await fetch(`/api/admin/techs/${tech.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !tech.is_active }),
    })
    const data = await res.json()
    if (res.ok && data.profile) {
      setTechs(ts => ts.map(t => t.id === tech.id ? data.profile : t))
    }
    setTogglingId(null)
  }

  async function handleChangeEmail(techId: string) {
    const newEmail = emailForm[techId]?.trim()
    if (!newEmail || !newEmail.includes('@')) {
      setError('Please enter a valid email address.')
      return
    }
    setError('')
    setSuccess('')
    const res = await fetch(`/api/admin/techs/${techId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_email: newEmail }),
    })
    if (res.ok) {
      setTechs(ts => ts.map(t => t.id === techId ? { ...t, email: newEmail.toLowerCase() } : t))
      setSuccess('Email updated successfully.')
      setEmailingId(null)
      setEmailForm({})
    } else {
      const data = await res.json()
      setError(data.error ?? 'Failed to update email')
    }
  }

  async function handleSaveBonus(techId: string) {
    const raw = bonusForm[techId]?.trim()
    const val = parseFloat(raw ?? '')
    if (isNaN(val) || val < 0) {
      setError('Enter a valid non-negative dollar amount.')
      return
    }
    setError('')
    setSuccess('')
    const res = await fetch(`/api/admin/techs/${techId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weekly_bonus: val }),
    })
    if (res.ok) {
      setTechs(ts => ts.map(t => t.id === techId ? { ...t, weekly_bonus: val } : t))
      setSuccess('Weekly bonus updated.')
      setBonusId(null)
      setBonusForm({})
    } else {
      const data = await res.json()
      setError(data.error ?? 'Failed to update bonus')
    }
  }

  async function handleResetPassword(techId: string) {
    const pw = resetForm[techId]
    if (!pw || pw.length < 6) {
      setError('Password must be at least 6 characters.')
      return
    }
    setError('')
    setSuccess('')
    const res = await fetch(`/api/admin/techs/${techId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_password: pw }),
    })
    if (res.ok) {
      setSuccess('Password reset successfully.')
      setResetingId(null)
      setResetForm({})
    } else {
      const data = await res.json()
      setError(data.error ?? 'Failed to reset password')
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">Technicians</h1>
        <button
          onClick={() => { setShowNewForm(true); setError(''); setSuccess('') }}
          className="bg-red-600 hover:bg-red-600 text-white text-sm font-medium px-4 py-2 rounded-md transition-colors"
        >
          + Add Technician
        </button>
      </div>

      {success && (
        <div className="bg-green-50 border border-green-200 rounded px-4 py-2 text-sm text-green-800">
          {success}
        </div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded px-4 py-2 text-sm text-red-600">
          {error}
        </div>
      )}

      {/* New tech form */}
      {showNewForm && (
        <form
          onSubmit={handleCreateTech}
          className="bg-white border border-red-200 rounded-lg p-4 space-y-3"
        >
          <h2 className="text-sm font-semibold text-gray-800">New Technician</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Full Name</label>
              <input
                type="text"
                required
                value={form.full_name}
                onChange={e => setForm({ ...form, full_name: e.target.value })}
                className="border border-gray-300 rounded px-2 py-1.5 text-base text-gray-900 w-full focus:outline-none focus:ring-2 focus:ring-red-400"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Email</label>
              <input
                type="email"
                required
                value={form.email}
                onChange={e => setForm({ ...form, email: e.target.value })}
                className="border border-gray-300 rounded px-2 py-1.5 text-base text-gray-900 w-full focus:outline-none focus:ring-2 focus:ring-red-400"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Temporary Password</label>
              <input
                type="text"
                required
                minLength={6}
                value={form.password}
                onChange={e => setForm({ ...form, password: e.target.value })}
                className="border border-gray-300 rounded px-2 py-1.5 text-base text-gray-900 w-full focus:outline-none focus:ring-2 focus:ring-red-400"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowNewForm(false)}
              className="border border-gray-300 text-gray-600 rounded px-3 py-1.5 text-sm hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="bg-red-600 text-white rounded px-3 py-1.5 text-sm hover:bg-red-600 disabled:opacity-60"
            >
              {saving ? 'Creating…' : 'Create Technician'}
            </button>
          </div>
        </form>
      )}

      {/* Techs table */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-3 font-medium text-gray-600">Name</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Email</th>
                <th className="text-center px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {techs.length === 0 && (
                <tr>
                  <td colSpan={4} className="text-center py-8 text-gray-400 text-sm">
                    No technicians yet. Add one above.
                  </td>
                </tr>
              )}
              {techs.map(tech => (
                <>
                  <tr key={tech.id} className={tech.is_active ? '' : 'opacity-50'}>
                    <td className="px-4 py-3 font-medium text-gray-900">
                      {tech.full_name}
                      {tech.weekly_bonus > 0 && (
                        <span className="ml-2 text-xs text-purple-700 bg-purple-50 border border-purple-200 px-1.5 py-0.5 rounded font-medium">
                          +${tech.weekly_bonus.toFixed(0)}/wk
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-sm">{tech.email}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                        tech.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                      }`}>
                        {tech.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-3 text-xs">
                        <button
                          onClick={() => {
                            setBonusId(bonusId === tech.id ? null : tech.id)
                            setBonusForm(f => ({ ...f, [tech.id]: String(tech.weekly_bonus) }))
                            setEmailingId(null)
                            setResetingId(null)
                            setError('')
                          }}
                          className="text-purple-600 hover:underline"
                        >
                          Set Bonus
                        </button>
                        <button
                          onClick={() => {
                            setEmailingId(emailingId === tech.id ? null : tech.id)
                            setResetingId(null)
                            setBonusId(null)
                            setError('')
                          }}
                          className="text-red-600 hover:underline"
                        >
                          Change Email
                        </button>
                        <button
                          onClick={() => {
                            setResetingId(resetingId === tech.id ? null : tech.id)
                            setEmailingId(null)
                            setBonusId(null)
                            setError('')
                          }}
                          className="text-red-600 hover:underline"
                        >
                          Reset Password
                        </button>
                        <button
                          onClick={() => handleToggleActive(tech)}
                          disabled={togglingId === tech.id}
                          className="text-gray-600 hover:underline disabled:opacity-50"
                        >
                          {tech.is_active ? 'Deactivate' : 'Reactivate'}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {bonusId === tech.id && (
                    <tr key={`${tech.id}-bonus`}>
                      <td colSpan={4} className="bg-purple-50 px-4 py-3">
                        <div className="flex gap-2 items-center flex-wrap">
                          <label className="text-xs text-gray-600 whitespace-nowrap">Weekly bonus ($):</label>
                          <input
                            type="number"
                            min="0"
                            step="1"
                            value={bonusForm[tech.id] ?? '0'}
                            onChange={e => setBonusForm(f => ({ ...f, [tech.id]: e.target.value }))}
                            className="border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900 w-28 focus:outline-none focus:ring-2 focus:ring-purple-400"
                          />
                          <span className="text-xs text-gray-400">Set to 0 to remove</span>
                          <button
                            onClick={() => handleSaveBonus(tech.id)}
                            className="bg-purple-600 text-white rounded px-3 py-1.5 text-xs hover:bg-purple-700"
                          >
                            Save Bonus
                          </button>
                          <button
                            onClick={() => { setBonusId(null); setBonusForm({}) }}
                            className="text-gray-500 hover:underline text-xs"
                          >
                            Cancel
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                  {emailingId === tech.id && (
                    <tr key={`${tech.id}-email`}>
                      <td colSpan={4} className="bg-blue-50 px-4 py-3">
                        <div className="flex gap-2 items-center">
                          <label className="text-xs text-gray-600 whitespace-nowrap">New email:</label>
                          <input
                            type="email"
                            value={emailForm[tech.id] ?? ''}
                            onChange={e => setEmailForm(f => ({ ...f, [tech.id]: e.target.value }))}
                            placeholder={tech.email}
                            className="border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900 w-56 focus:outline-none focus:ring-2 focus:ring-red-400"
                          />
                          <button
                            onClick={() => handleChangeEmail(tech.id)}
                            className="bg-blue-600 text-white rounded px-3 py-1.5 text-xs hover:bg-blue-700"
                          >
                            Save Email
                          </button>
                          <button
                            onClick={() => { setEmailingId(null); setEmailForm({}) }}
                            className="text-gray-500 hover:underline text-xs"
                          >
                            Cancel
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                  {resetingId === tech.id && (
                    <tr key={`${tech.id}-reset`}>
                      <td colSpan={4} className="bg-yellow-50 px-4 py-3">
                        <div className="flex gap-2 items-center">
                          <label className="text-xs text-gray-600 whitespace-nowrap">New password:</label>
                          <input
                            type="text"
                            minLength={6}
                            value={resetForm[tech.id] ?? ''}
                            onChange={e => setResetForm(f => ({ ...f, [tech.id]: e.target.value }))}
                            className="border border-gray-300 rounded px-2 py-1.5 text-base text-gray-900 w-40 focus:outline-none focus:ring-2 focus:ring-red-400"
                          />
                          <button
                            onClick={() => handleResetPassword(tech.id)}
                            className="bg-yellow-500 text-white rounded px-3 py-1.5 text-xs hover:bg-yellow-600"
                          >
                            Set Password
                          </button>
                          <button
                            onClick={() => { setResetingId(null); setResetForm({}) }}
                            className="text-gray-500 hover:underline text-xs"
                          >
                            Cancel
                          </button>
                        </div>
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
