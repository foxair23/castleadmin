'use client'

import { useState, useEffect } from 'react'

interface PushLogRow {
  id: string
  pushed_at: string
  tag: string
  contact_count: number
  added_count: number
  updated_count: number
  skipped_count: number
  failed_count: number
}

interface StatusData {
  connected: boolean
  audience: { id: string; name: string; member_count: number } | null
  error: string | null
}

export default function MailchimpClient({
  pushLog,
  serverPrefix,
}: {
  pushLog: PushLogRow[]
  serverPrefix: string
}) {
  const [status, setStatus] = useState<StatusData | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)

  async function fetchStatus() {
    setStatusLoading(true)
    try {
      const res = await fetch('/api/admin/mailchimp/status')
      const data = await res.json()
      setStatus(data as StatusData)
    } catch {
      setStatus({ connected: false, audience: null, error: 'Network error' })
    } finally {
      setStatusLoading(false)
    }
  }

  useEffect(() => {
    fetchStatus()
  }, [])

  function formatDate(iso: string) {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  const notConfigured = status && !status.connected && !serverPrefix

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      <h1 className="text-2xl font-bold text-white">Mailchimp Settings</h1>

      {/* Connection status card */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-white">Connection Status</h2>
          <button
            onClick={fetchStatus}
            disabled={statusLoading}
            className="bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 text-white text-sm font-medium px-3 py-1.5 rounded transition-colors"
          >
            {statusLoading ? 'Checking...' : 'Test Connection'}
          </button>
        </div>

        {statusLoading && (
          <div className="h-6 w-48 bg-gray-800 rounded animate-pulse" />
        )}

        {!statusLoading && status && (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <span
                className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                  status.connected
                    ? 'bg-green-900/50 text-green-300 border border-green-800'
                    : 'bg-red-900/50 text-red-300 border border-red-800'
                }`}
              >
                {status.connected ? 'Connected' : 'Not configured'}
              </span>
              {serverPrefix && (
                <span className="text-sm text-gray-400">Server: <span className="text-gray-200">{serverPrefix}</span></span>
              )}
            </div>

            {status.connected && status.audience && (
              <div className="text-sm text-gray-300 space-y-1">
                <div>Audience: <span className="text-white font-medium">{status.audience.name}</span></div>
                <div>Members: <span className="text-white font-medium">{status.audience.member_count.toLocaleString()}</span></div>
              </div>
            )}

            {status.error && (
              <div className="text-sm text-red-400">{status.error}</div>
            )}
          </div>
        )}
      </div>

      {/* Not configured callout */}
      {notConfigured && (
        <div className="bg-yellow-900/20 border border-yellow-800 rounded-lg p-4 text-sm text-yellow-300">
          <strong>Not configured.</strong> Add{' '}
          <code className="bg-yellow-900/40 px-1 rounded">MAILCHIMP_API_KEY</code>,{' '}
          <code className="bg-yellow-900/40 px-1 rounded">MAILCHIMP_AUDIENCE_ID</code>, and{' '}
          <code className="bg-yellow-900/40 px-1 rounded">MAILCHIMP_SERVER_PREFIX</code>{' '}
          to your Vercel environment variables.
        </div>
      )}

      {/* Push History */}
      <div>
        <h2 className="text-base font-semibold text-white mb-3">Push History</h2>
        {pushLog.length === 0 ? (
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 text-center text-gray-500">
            No pushes yet.
          </div>
        ) : (
          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800">
                    <th className="px-4 py-3 text-left text-gray-400 font-medium">Date</th>
                    <th className="px-4 py-3 text-left text-gray-400 font-medium">Tag</th>
                    <th className="px-4 py-3 text-right text-gray-400 font-medium">Contacts</th>
                    <th className="px-4 py-3 text-right text-gray-400 font-medium">Added</th>
                    <th className="px-4 py-3 text-right text-gray-400 font-medium">Updated</th>
                    <th className="px-4 py-3 text-right text-gray-400 font-medium">Skipped</th>
                    <th className="px-4 py-3 text-right text-gray-400 font-medium">Errors</th>
                  </tr>
                </thead>
                <tbody>
                  {pushLog.map(row => (
                    <tr key={row.id} className="border-b border-gray-800 last:border-0 hover:bg-gray-800/30">
                      <td className="px-4 py-3 text-gray-300 whitespace-nowrap">{formatDate(row.pushed_at)}</td>
                      <td className="px-4 py-3 text-white font-mono text-xs">{row.tag}</td>
                      <td className="px-4 py-3 text-right text-gray-300">{row.contact_count}</td>
                      <td className="px-4 py-3 text-right text-green-400">{row.added_count}</td>
                      <td className="px-4 py-3 text-right text-blue-400">{row.updated_count}</td>
                      <td className="px-4 py-3 text-right text-yellow-400">{row.skipped_count}</td>
                      <td className="px-4 py-3 text-right text-red-400">{row.failed_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
