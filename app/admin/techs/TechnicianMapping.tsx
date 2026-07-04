'use client'

import { useState, useEffect } from 'react'

interface AppTech {
  id: string
  full_name: string
  is_active: boolean
  sf_technician_id: string | null
}

interface SFTech {
  id: string
  name: string
}

// Maps each app technician to their Service Fusion account. Lives on the Users
// page (moved here from the Integrations/Service Fusion page) since it's user
// administration. The bulk "Sync All Techs from SF" and connection test remain
// on Integrations.
export default function TechnicianMapping({ initialTechs }: { initialTechs: AppTech[] }) {
  const [sfTechs, setSfTechs] = useState<SFTech[]>([])
  const [sfTechsLoading, setSfTechsLoading] = useState(false)
  const [sfTechsError, setSfTechsError] = useState('')

  const [mappings, setMappings] = useState<Record<string, string>>(
    () => Object.fromEntries(initialTechs.map(t => [t.id, t.sf_technician_id ?? '']))
  )
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [saved, setSaved] = useState<Record<string, boolean>>({})
  const [syncing, setSyncing] = useState<Record<string, boolean>>({})
  const [syncResult, setSyncResult] = useState<Record<string, string>>({})

  useEffect(() => { loadSfTechs() }, [])

  async function loadSfTechs() {
    setSfTechsLoading(true)
    setSfTechsError('')
    try {
      const res = await fetch('/api/admin/sf/technicians')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to load')
      setSfTechs(data.technicians)
    } catch (err: unknown) {
      setSfTechsError(err instanceof Error ? err.message : 'Failed to load SF technicians')
    }
    setSfTechsLoading(false)
  }

  async function syncTechJobs(techId: string) {
    const sfTechId = mappings[techId]
    if (!sfTechId) return
    setSyncing(s => ({ ...s, [techId]: true }))
    setSyncResult(r => ({ ...r, [techId]: '' }))
    try {
      const res = await fetch('/api/admin/sf/sync-tech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sf_tech_id: sfTechId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Sync failed')
      setSyncResult(r => ({ ...r, [techId]: `Synced ${data.jobsMatched} jobs (scanned ${data.scanned})` }))
    } catch (err: unknown) {
      setSyncResult(r => ({ ...r, [techId]: err instanceof Error ? err.message : 'Sync failed' }))
    }
    setSyncing(s => ({ ...s, [techId]: false }))
  }

  async function saveMapping(techId: string) {
    setSaving(s => ({ ...s, [techId]: true }))
    const res = await fetch('/api/admin/sf/mapping', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tech_id: techId, sf_technician_id: mappings[techId] || null }),
    })
    setSaving(s => ({ ...s, [techId]: false }))
    if (res.ok) {
      setSaved(s => ({ ...s, [techId]: true }))
      setTimeout(() => setSaved(s => ({ ...s, [techId]: false })), 2000)
    }
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
        <div>
          <h2 className="text-sm font-semibold text-gray-800">Technician Mapping</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Match each app technician to their Service Fusion account.
          </p>
        </div>
        <button
          onClick={loadSfTechs}
          disabled={sfTechsLoading}
          className="text-xs text-red-600 hover:underline disabled:opacity-50 whitespace-nowrap"
        >
          {sfTechsLoading ? 'Loading…' : 'Refresh SF List'}
        </button>
      </div>

      {sfTechsError && (
        <div className="px-4 py-3 text-sm text-red-700 bg-red-50 border-b border-red-200">
          {sfTechsError}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="text-left px-4 py-3 font-medium text-gray-600">App Technician</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Service Fusion Technician</th>
              <th className="text-center px-4 py-3 font-medium text-gray-600">Status</th>
              <th className="px-4 py-3"></th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {initialTechs.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center py-8 text-gray-400 text-sm">
                  No technicians found. Add technicians above first.
                </td>
              </tr>
            )}
            {initialTechs.map(tech => (
              <tr key={tech.id} className={tech.is_active ? '' : 'opacity-50'}>
                <td className="px-4 py-3 font-medium text-gray-900">
                  {tech.full_name}
                  {!tech.is_active && <span className="ml-1 text-xs text-gray-400">(inactive)</span>}
                </td>
                <td className="px-4 py-3">
                  <select
                    value={mappings[tech.id] ?? ''}
                    onChange={e => setMappings(m => ({ ...m, [tech.id]: e.target.value }))}
                    disabled={sfTechsLoading}
                    className="border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900 w-full max-w-xs focus:outline-none focus:ring-2 focus:ring-red-400 disabled:opacity-60"
                  >
                    <option value="">— Not mapped —</option>
                    {sfTechs.map(st => (
                      <option key={st.id} value={st.id}>{st.name}</option>
                    ))}
                  </select>
                  {sfTechs.length === 0 && !sfTechsLoading && (
                    <p className="text-xs text-gray-400 mt-1">
                      Use “Refresh SF List” to load Service Fusion technicians.
                    </p>
                  )}
                </td>
                <td className="px-4 py-3 text-center">
                  {mappings[tech.id] ? (
                    <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
                      Mapped ✓
                    </span>
                  ) : (
                    <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700">
                      ⚠ Needs mapping
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => saveMapping(tech.id)}
                    disabled={saving[tech.id]}
                    className="text-xs bg-red-600 text-white px-3 py-1.5 rounded hover:bg-red-700 disabled:opacity-60 whitespace-nowrap"
                  >
                    {saving[tech.id] ? 'Saving…' : saved[tech.id] ? 'Saved ✓' : 'Save'}
                  </button>
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  {mappings[tech.id] && (
                    <div className="flex flex-col gap-0.5">
                      <button
                        onClick={() => syncTechJobs(tech.id)}
                        disabled={syncing[tech.id]}
                        className="text-xs bg-gray-700 text-white px-3 py-1.5 rounded hover:bg-gray-800 disabled:opacity-60 whitespace-nowrap"
                      >
                        {syncing[tech.id] ? 'Syncing…' : 'Resync Jobs'}
                      </button>
                      {syncResult[tech.id] && (
                        <span className={`text-xs ${syncResult[tech.id].startsWith('Synced') ? 'text-green-600' : 'text-red-600'}`}>
                          {syncResult[tech.id]}
                        </span>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
