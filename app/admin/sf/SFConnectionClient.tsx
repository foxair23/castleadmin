'use client'

import { useState } from 'react'

export default function SFConnectionClient() {
  const [testing, setTesting] = useState(false)
  const [connectionResult, setConnectionResult] = useState<{ ok: boolean; error?: string } | null>(null)

  const [syncingAll, setSyncingAll] = useState(false)
  const [syncAllResult, setSyncAllResult] = useState<string>('')

  async function testConnection() {
    setTesting(true)
    setConnectionResult(null)
    try {
      const res = await fetch('/api/admin/sf/test')
      const data = await res.json()
      setConnectionResult({ ok: data.connected, error: data.error })
    } catch {
      setConnectionResult({ ok: false, error: 'Network error' })
    }
    setTesting(false)
  }

  async function syncAllTechs() {
    setSyncingAll(true)
    setSyncAllResult('')

    // Build last 8 week-start dates (Mondays) client-side
    const weekStarts: string[] = []
    const d = new Date()
    // Rewind to most recent Monday
    const day = d.getDay()
    d.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
    for (let i = 0; i < 8; i++) {
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, '0')
      const dd = String(d.getDate()).padStart(2, '0')
      weekStarts.push(`${y}-${m}-${dd}`)
      d.setDate(d.getDate() - 7)
    }

    let totalAdded = 0
    let totalUpdated = 0
    let techCount = 0

    for (let i = 0; i < weekStarts.length; i++) {
      const weekStart = weekStarts[i]
      setSyncAllResult(`Syncing week ${i + 1} of ${weekStarts.length} (${weekStart})…`)
      try {
        const res = await fetch('/api/admin/sf/sync-all', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ weekStart }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'Sync failed')
        totalAdded += data.added
        totalUpdated += data.updated
        techCount = data.techCount
      } catch (err: unknown) {
        setSyncAllResult(err instanceof Error ? err.message : 'Sync failed')
        setSyncingAll(false)
        return
      }
    }

    setSyncAllResult(`Done — ${totalAdded} jobs added, ${totalUpdated} updated across ${techCount} techs (last 8 weeks)`)
    setSyncingAll(false)
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-gray-900">Service Fusion Connection</h1>

      {/* Connection status */}
      <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-800 mb-1">Connection Status</h2>
          <p className="text-xs text-gray-500">
            Credentials are stored as Vercel environment variables{' '}
            <code className="bg-gray-100 px-1 rounded">SF_CLIENT_ID</code> and{' '}
            <code className="bg-gray-100 px-1 rounded">SF_CLIENT_SECRET</code> — never entered here.
          </p>
        </div>

        {connectionResult && (
          <div className={`text-sm px-3 py-2 rounded border ${
            connectionResult.ok
              ? 'bg-green-50 border-green-200 text-green-800'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}>
            {connectionResult.ok
              ? 'Connected to Service Fusion ✓'
              : `Connection failed: ${connectionResult.error}`}
          </div>
        )}

        <button
          onClick={testConnection}
          disabled={testing}
          className="bg-red-600 text-white text-sm font-medium px-4 py-2 rounded-md hover:bg-red-700 disabled:opacity-60"
        >
          {testing ? 'Testing…' : 'Test Connection'}
        </button>
      </div>

      {/* Sync all techs */}
      <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-800 mb-1">Sync All Technicians</h2>
          <p className="text-xs text-gray-500">
            Pulls jobs from Service Fusion for all mapped techs for the last 8 weeks and creates piecework entries where none exist. This is the same sync techs run from their own view.
          </p>
        </div>
        {syncAllResult && (
          <div className={`text-sm px-3 py-2 rounded border ${
            syncAllResult.startsWith('Done')
              ? 'bg-green-50 border-green-200 text-green-800'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}>
            {syncAllResult}
          </div>
        )}
        <button
          onClick={syncAllTechs}
          disabled={syncingAll}
          className="bg-gray-800 text-white text-sm font-medium px-4 py-2 rounded-md hover:bg-gray-900 disabled:opacity-60"
        >
          {syncingAll ? 'Syncing… (this may take up to 60 seconds)' : 'Sync All Techs from SF'}
        </button>
      </div>
    </div>
  )
}
