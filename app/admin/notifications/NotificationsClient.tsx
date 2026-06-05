'use client'

import React, { useState } from 'react'

export interface NotificationType {
  id: string
  key: string
  display_name: string
  description: string | null
  category: string
}

export interface UserRow {
  id: string
  full_name: string
  role: string
  is_dispatch: boolean
  prefs: Record<string, boolean>  // notification_type_id → is_enabled
}

export interface ActivityRow {
  id: string
  createdAt: string
  userName: string
  typeName: string
  status: string
  subject: string
  relatedEntityType: string | null
  relatedEntityId: string | null
  errorMessage: string | null
}

export default function NotificationsClient({
  types,
  users,
  activity,
}: {
  types: NotificationType[]
  users: UserRow[]
  activity: ActivityRow[]
}) {
  const [rows, setRows] = useState(users)
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [activityOpen, setActivityOpen] = useState(false)
  const [expandedError, setExpandedError] = useState<string | null>(null)

  async function handleToggle(userId: string, typeId: string, current: boolean) {
    const key = `${userId}-${typeId}`
    setSaving(key)
    setError('')

    const res = await fetch('/api/admin/notifications', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, notificationTypeId: typeId, isEnabled: !current }),
    })

    if (res.ok) {
      setRows(rs =>
        rs.map(r =>
          r.id === userId
            ? { ...r, prefs: { ...r.prefs, [typeId]: !current } }
            : r
        )
      )
    } else {
      const data = await res.json()
      setError(data.error ?? 'Failed to update preference')
    }
    setSaving(null)
  }

  const roleOrder = ['admin', 'sales', 'technician']
  const sorted = [...rows].sort((a, b) => {
    const ri = roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role)
    if (ri !== 0) return ri
    return a.full_name.localeCompare(b.full_name)
  })

  const roleLabel: Record<string, string> = {
    admin: 'Admin',
    sales: 'Sales',
    technician: 'Technician',
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Notification Settings</h1>
        <p className="text-sm text-gray-500 mt-1">
          Configure which users receive each email notification.
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded px-4 py-2 text-sm text-red-600">
          {error}
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-3 font-medium text-gray-600 min-w-[180px]">User</th>
                {types.map(t => (
                  <th key={t.id} className="text-center px-3 py-3 font-medium text-gray-600 min-w-[120px]">
                    <span className="block">{t.display_name}</span>
                    {t.description && (
                      <span className="block text-xs text-gray-400 font-normal mt-0.5 max-w-[140px] mx-auto">
                        {t.description}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={types.length + 1} className="text-center py-8 text-gray-400">
                    No users found.
                  </td>
                </tr>
              )}
              {sorted.map(user => (
                <tr key={user.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{user.full_name}</div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                        user.role === 'admin'
                          ? 'bg-red-100 text-red-700'
                          : user.role === 'sales'
                          ? 'bg-blue-100 text-blue-700'
                          : 'bg-gray-100 text-gray-600'
                      }`}>
                        {roleLabel[user.role] ?? user.role}
                      </span>
                      {user.is_dispatch && (
                        <span className="text-xs bg-teal-100 text-teal-700 px-1.5 py-0.5 rounded-full font-medium">
                          Dispatch
                        </span>
                      )}
                    </div>
                  </td>
                  {types.map(t => {
                    const enabled = user.prefs[t.id] ?? false
                    const key = `${user.id}-${t.id}`
                    const isSaving = saving === key
                    return (
                      <td key={t.id} className="px-3 py-3 text-center">
                        <button
                          onClick={() => handleToggle(user.id, t.id, enabled)}
                          disabled={isSaving}
                          title={enabled ? 'Click to disable' : 'Click to enable'}
                          className={`w-9 h-5 rounded-full transition-colors relative inline-flex items-center disabled:opacity-50 ${
                            enabled ? 'bg-green-500' : 'bg-gray-300'
                          }`}
                        >
                          <span
                            className={`absolute h-4 w-4 rounded-full bg-white shadow transition-transform ${
                              enabled ? 'translate-x-4' : 'translate-x-0.5'
                            }`}
                          />
                        </button>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="text-xs text-gray-400">
        Changes take effect immediately. Toggle switches turn green when a notification is enabled.
      </div>

      {/* Recent Notifications Activity Panel */}
      <div className="border border-gray-200 rounded-lg overflow-hidden">
        <button
          onClick={() => setActivityOpen(o => !o)}
          className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
        >
          <span className="font-medium text-gray-700 text-sm">
            Recent Notifications — Last 7 Days
            <span className="ml-2 text-xs text-gray-400 font-normal">({activity.length} entries)</span>
          </span>
          <svg
            className={`w-4 h-4 text-gray-400 transition-transform ${activityOpen ? 'rotate-180' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {activityOpen && (
          <div className="overflow-x-auto">
            {activity.length === 0 ? (
              <div className="text-center py-8 text-gray-400 text-sm">No notifications in the last 7 days.</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 bg-white">
                    <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">Time</th>
                    <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">Recipient</th>
                    <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">Type</th>
                    <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">Subject</th>
                    <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">Status</th>
                    <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">Entity</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {activity.map(row => {
                    const statusColors: Record<string, string> = {
                      sent: 'bg-green-100 text-green-700',
                      queued: 'bg-yellow-100 text-yellow-700',
                      sending: 'bg-blue-100 text-blue-700',
                      failed: 'bg-red-100 text-red-700',
                      deduped: 'bg-gray-100 text-gray-500',
                    }
                    const isExpanded = expandedError === row.id
                    return (
                      <React.Fragment key={row.id}>
                        <tr
                          className={`${row.status === 'failed' ? 'cursor-pointer hover:bg-red-50' : ''}`}
                          onClick={() => {
                            if (row.status === 'failed') {
                              setExpandedError(isExpanded ? null : row.id)
                            }
                          }}
                        >
                          <td className="px-4 py-2 text-gray-500 whitespace-nowrap text-xs">
                            {new Date(row.createdAt).toLocaleString('en-US', {
                              month: 'short', day: 'numeric',
                              hour: 'numeric', minute: '2-digit',
                            })}
                          </td>
                          <td className="px-4 py-2 text-gray-900 whitespace-nowrap">{row.userName}</td>
                          <td className="px-4 py-2 text-gray-700 whitespace-nowrap">{row.typeName}</td>
                          <td className="px-4 py-2 text-gray-600 max-w-[240px] truncate" title={row.subject}>
                            {row.subject}
                          </td>
                          <td className="px-4 py-2">
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColors[row.status] ?? 'bg-gray-100 text-gray-600'}`}>
                              {row.status}
                            </span>
                            {row.status === 'failed' && (
                              <span className="ml-1 text-xs text-red-400">{isExpanded ? '▲' : '▼'}</span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-gray-400 text-xs whitespace-nowrap">
                            {row.relatedEntityType && row.relatedEntityId
                              ? `${row.relatedEntityType}:${row.relatedEntityId.slice(0, 8)}…`
                              : row.relatedEntityType ?? '—'}
                          </td>
                        </tr>
                        {isExpanded && row.errorMessage && (
                          <tr>
                            <td colSpan={6} className="px-4 py-2 bg-red-50 text-xs text-red-700 font-mono">
                              {row.errorMessage}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
