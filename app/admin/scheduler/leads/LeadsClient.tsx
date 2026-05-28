'use client'

import { useState } from 'react'
import Link from 'next/link'

interface Lead {
  id: string
  created_at: string
  status: 'pending' | 'approved' | 'rejected'
  sync_status: string
  is_partial: boolean
  service_type: string | null
  service_category: string | null
  quoted_fee: string | null
  customer_first_name: string
  customer_last_name: string | null
  customer_phone: string
  address_city: string | null
  address_state: string | null
  address_in_service_area: boolean | null
  appointment_date: string | null
  appointment_window_start: string | null
  appointment_window_end: string | null
}

type StatusFilter = 'all' | 'pending' | 'approved' | 'rejected' | 'partial'

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  pending:  { bg: 'bg-yellow-100', text: 'text-yellow-800', label: 'Pending' },
  approved: { bg: 'bg-green-100',  text: 'text-green-800',  label: 'Approved' },
  rejected: { bg: 'bg-red-100',    text: 'text-red-800',    label: 'Rejected' },
}

const SYNC_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  not_attempted:  { bg: 'bg-gray-100',   text: 'text-gray-600',   label: '—' },
  in_progress:    { bg: 'bg-blue-100',   text: 'text-blue-700',   label: 'Syncing' },
  synced:         { bg: 'bg-green-100',  text: 'text-green-700',  label: 'Synced' },
  sync_failed:    { bg: 'bg-red-100',    text: 'text-red-700',    label: 'Failed' },
  manually_synced:{ bg: 'bg-purple-100', text: 'text-purple-700', label: 'Manual' },
}

function formatApptDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function formatWindow(start: string, end: string): string {
  function fmt(t: string) {
    const [h] = t.split(':').map(Number)
    return h >= 12 ? `${h === 12 ? 12 : h - 12}pm` : `${h}am`
  }
  return `${fmt(start)}–${fmt(end)}`
}

function Badge({ bg, text, label }: { bg: string; text: string; label: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${bg} ${text}`}>
      {label}
    </span>
  )
}

export default function LeadsClient({ initialLeads }: { initialLeads: Lead[] }) {
  const [filter, setFilter] = useState<StatusFilter>('pending')

  const fullLeads = initialLeads.filter(l => !l.is_partial)
  const partialLeads = initialLeads.filter(l => l.is_partial)

  const counts = {
    all: fullLeads.length,
    pending: fullLeads.filter(l => l.status === 'pending').length,
    approved: fullLeads.filter(l => l.status === 'approved').length,
    rejected: fullLeads.filter(l => l.status === 'rejected').length,
    partial: partialLeads.length,
  }

  const visible =
    filter === 'partial' ? partialLeads :
    filter === 'all' ? fullLeads :
    fullLeads.filter(l => l.status === filter)

  const tabs: { key: StatusFilter; label: string }[] = [
    { key: 'pending',  label: `Pending (${counts.pending})` },
    { key: 'approved', label: `Approved (${counts.approved})` },
    { key: 'rejected', label: `Rejected (${counts.rejected})` },
    { key: 'all',      label: `All (${counts.all})` },
    { key: 'partial',  label: `Partial (${counts.partial})` },
  ]

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Scheduler Leads</h1>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 mb-4 border-b border-gray-200">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              filter === tab.key
                ? 'border-red-600 text-red-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          No {filter === 'all' ? '' : filter} leads yet.
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">ID</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Customer</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Service</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Appointment</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Area</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Sync</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {visible.map(lead => {
                const ss = STATUS_STYLES[lead.status] ?? STATUS_STYLES.pending
                const sy = SYNC_STYLES[lead.sync_status] ?? SYNC_STYLES.not_attempted
                return (
                  <tr key={lead.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-xs text-gray-500">
                      <Link href={`/admin/scheduler/leads/${lead.id}`} className="hover:text-red-600">
                        {lead.id.slice(0, 8)}…
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <Link href={`/admin/scheduler/leads/${lead.id}`} className="font-medium text-gray-900 hover:text-red-600">
                          {lead.customer_first_name}{lead.customer_last_name ? ` ${lead.customer_last_name}` : ''}
                        </Link>
                        {lead.is_partial && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-700">Partial</span>
                        )}
                      </div>
                      <span className="text-gray-400 text-xs">
                        {lead.address_city ? `${lead.address_city}${lead.address_state ? `, ${lead.address_state}` : ''}` : lead.customer_phone}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {lead.service_category ? (
                        <>
                          <div>{lead.service_category}</div>
                          <span className="text-gray-400 text-xs capitalize">{lead.service_type?.replace(/_/g, ' ')}</span>
                          {lead.quoted_fee && (
                            <span className={`mt-0.5 inline-block text-xs font-medium px-1.5 py-0.5 rounded ${
                              lead.quoted_fee === 'Free Estimate'
                                ? 'bg-green-50 text-green-700'
                                : 'bg-blue-50 text-blue-700'
                            }`}>
                              {lead.quoted_fee}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-gray-400 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {lead.appointment_date ? (
                        <>
                          <div>{formatApptDate(lead.appointment_date)}</div>
                          {lead.appointment_window_start && lead.appointment_window_end && (
                            <span className="text-gray-400 text-xs">{formatWindow(lead.appointment_window_start, lead.appointment_window_end)}</span>
                          )}
                        </>
                      ) : (
                        <span className="text-gray-400 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {lead.address_in_service_area === null ? (
                        <span className="text-gray-400 text-xs">unknown</span>
                      ) : lead.address_in_service_area ? (
                        <span className="text-green-600 text-xs font-medium">✓ In area</span>
                      ) : (
                        <span className="text-red-500 text-xs font-medium">✗ Outside</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {lead.is_partial && lead.status === 'pending'
                        ? <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-700">Partial</span>
                        : lead.is_partial && lead.status === 'approved'
                          ? <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">Actioned</span>
                          : <Badge {...ss} />
                      }
                    </td>
                    <td className="px-4 py-3">
                      {!lead.is_partial && lead.sync_status !== 'not_attempted' && <Badge {...sy} />}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
