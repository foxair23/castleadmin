'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

export interface SalesLead {
  id: string
  customer_id: string
  customer_name: string
  account_number: string | null
  last_serviced_date: string | null
  phone: string | null
  customer_city: string | null
  customer_state: string | null
  mailchimp_campaign_id: string
  campaign_subject: string | null
  tag_name: string | null
  status: string
  assigned_to_user_id: string | null
  assigned_rep_name: string | null
  open_count: number
  click_count: number
  last_opened_at: string | null
  last_activity_at: string | null
  days_since_activity: number | null
  days_since_created: number | null
  last_call_disposition: string | null
  closed_outcome: string | null
  sf_job_created: boolean
}

type StatusFilter = 'all' | 'New' | 'Contacted' | 'Engaged' | 'Quoted' | 'Closed Won' | 'Closed Lost'

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  'New':         { bg: 'bg-blue-100',   text: 'text-blue-800' },
  'Contacted':   { bg: 'bg-yellow-100', text: 'text-yellow-800' },
  'Engaged':     { bg: 'bg-purple-100', text: 'text-purple-800' },
  'Quoted':      { bg: 'bg-orange-100', text: 'text-orange-800' },
  'Closed Won':  { bg: 'bg-green-100',  text: 'text-green-800' },
  'Closed Lost': { bg: 'bg-gray-100',   text: 'text-gray-500' },
}

const DISPOSITION_COLORS: Record<string, { bg: string; text: string }> = {
  'Connected':          { bg: 'bg-green-100',  text: 'text-green-800' },
  'Voicemail':          { bg: 'bg-yellow-100', text: 'text-yellow-800' },
  'No Answer':          { bg: 'bg-gray-100',   text: 'text-gray-600' },
  'Bad Number':         { bg: 'bg-red-100',    text: 'text-red-700' },
  'Not Interested':     { bg: 'bg-red-100',    text: 'text-red-700' },
  'Callback Requested': { bg: 'bg-blue-100',   text: 'text-blue-700' },
  'Quote Sent':         { bg: 'bg-orange-100', text: 'text-orange-700' },
  'Closed Won':         { bg: 'bg-green-100',  text: 'text-green-800' },
  'Closed Lost':        { bg: 'bg-gray-100',   text: 'text-gray-500' },
}

function Badge({ label, bg, text }: { label: string; bg: string; text: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${bg} ${text}`}>
      {label}
    </span>
  )
}

function AgingDot({ days }: { days: number | null }) {
  if (days === null) return <span className="text-gray-400 text-xs">—</span>
  const color = days >= 14 ? 'text-red-600' : days >= 7 ? 'text-yellow-600' : 'text-gray-600'
  return <span className={`text-xs font-medium ${color}`}>{days}d</span>
}

export default function SalesLeadsClient({
  initialLeads,
  isAdmin,
}: {
  initialLeads: SalesLead[]
  isAdmin: boolean
}) {
  const router = useRouter()
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [tagFilter, setTagFilter] = useState<string>('all')
  const [sortField, setSortField] = useState<'customer_name' | 'status' | 'open_count' | 'last_activity_at' | 'days_since_created'>('last_activity_at')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'done' | 'error'>('idle')
  const [syncMessage, setSyncMessage] = useState('')
  const [, startTransition] = useTransition()

  function handleSort(field: typeof sortField) {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDir('asc')
    }
  }

  function SortIcon({ field }: { field: typeof sortField }) {
    if (sortField !== field) return <span className="ml-1 text-gray-300">↕</span>
    return <span className="ml-1 text-red-500">{sortDir === 'asc' ? '↑' : '↓'}</span>
  }

  const allTags = [...new Set(initialLeads.map(l => l.tag_name).filter(Boolean) as string[])].sort()

  const counts: Record<StatusFilter, number> = {
    all: initialLeads.length,
    'New': initialLeads.filter(l => l.status === 'New').length,
    'Contacted': initialLeads.filter(l => l.status === 'Contacted').length,
    'Engaged': initialLeads.filter(l => l.status === 'Engaged').length,
    'Quoted': initialLeads.filter(l => l.status === 'Quoted').length,
    'Closed Won': initialLeads.filter(l => l.status === 'Closed Won').length,
    'Closed Lost': initialLeads.filter(l => l.status === 'Closed Lost').length,
  }

  const visible = initialLeads
    .filter(l => filter === 'all' || l.status === filter)
    .filter(l => tagFilter === 'all' || l.tag_name === tagFilter)
    .sort((a, b) => {
      let cmp = 0
      switch (sortField) {
        case 'customer_name': cmp = (a.customer_name ?? '').localeCompare(b.customer_name ?? ''); break
        case 'status':        cmp = a.status.localeCompare(b.status); break
        case 'open_count':    cmp = a.open_count - b.open_count; break
        case 'last_activity_at': cmp = (a.days_since_activity ?? 9999) - (b.days_since_activity ?? 9999); break
        case 'days_since_created': cmp = (a.days_since_created ?? 9999) - (b.days_since_created ?? 9999); break
      }
      return sortDir === 'asc' ? cmp : -cmp
    })

  const tabs: { key: StatusFilter; label: string }[] = [
    { key: 'all',          label: `All (${counts.all})` },
    { key: 'New',          label: `New (${counts['New']})` },
    { key: 'Contacted',    label: `Contacted (${counts['Contacted']})` },
    { key: 'Engaged',      label: `Engaged (${counts['Engaged']})` },
    { key: 'Quoted',       label: `Quoted (${counts['Quoted']})` },
    { key: 'Closed Won',   label: `Closed Won (${counts['Closed Won']})` },
    { key: 'Closed Lost',  label: `Closed Lost (${counts['Closed Lost']})` },
  ]

  async function handleSync() {
    setSyncStatus('syncing')
    setSyncMessage('')
    try {
      const res = await fetch('/api/admin/sales/sync', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        setSyncStatus('error')
        setSyncMessage(data.error ?? 'Sync failed')
      } else {
        setSyncStatus('done')
        const parts = [`Synced ${data.campaignsSynced} campaign${data.campaignsSynced !== 1 ? 's' : ''}`]
        if ((data.totalOpeners ?? 0) > 0) {
          parts.push(`${data.totalOpeners} confirmed opener${data.totalOpeners !== 1 ? 's' : ''}`)
        }
        if ((data.totalLeads ?? 0) > (data.totalOpeners ?? 0)) {
          parts.push(`${data.totalLeads} total leads`)
        }
        if (data.unmatchedEmails > 0) {
          parts.push(`${data.unmatchedEmails} unmatched (link in Sales Admin)`)
        }
        parts.push(`${data.newOpeners} new lead${data.newOpeners !== 1 ? 's' : ''} created`)
        setSyncMessage(parts.join(' · '))
        startTransition(() => router.refresh())
      }
    } catch {
      setSyncStatus('error')
      setSyncMessage('Network error — please try again')
    }
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
        <h1 className="text-2xl font-bold text-gray-900">Sales Leads</h1>
        <div className="flex items-center gap-3">
          {syncMessage && (
            <span className={`text-sm ${syncStatus === 'error' ? 'text-red-600' : 'text-green-700'}`}>
              {syncMessage}
            </span>
          )}
          <button
            onClick={handleSync}
            disabled={syncStatus === 'syncing'}
            className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-60 transition-colors"
          >
            {syncStatus === 'syncing' ? (
              <>
                <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Syncing…
              </>
            ) : (
              'Sync from Mailchimp'
            )}
          </button>
        </div>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-1 mb-3 border-b border-gray-200 overflow-x-auto">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            className={`px-3 py-2 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${
              filter === tab.key
                ? 'border-red-600 text-red-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tag filter */}
      {allTags.length > 0 && (
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <span className="text-xs text-gray-500">Tag:</span>
          {(['all', ...allTags] as string[]).map(t => (
            <button
              key={t}
              onClick={() => setTagFilter(t)}
              className={`px-2.5 py-1 text-xs rounded-full font-medium transition-colors ${
                tagFilter === t
                  ? 'bg-gray-900 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {t === 'all' ? 'All tags' : t}
            </button>
          ))}
        </div>
      )}

      {visible.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          {initialLeads.length === 0
            ? 'No leads yet — click "Sync from Mailchimp" to import openers.'
            : 'No leads match the current filters.'}
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden overflow-x-auto">
          <table className="w-full text-sm min-w-[760px]">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  <button onClick={() => handleSort('customer_name')} className="flex items-center hover:text-gray-900">
                    Customer<SortIcon field="customer_name" />
                  </button>
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Campaign / Tag</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  <button onClick={() => handleSort('status')} className="flex items-center hover:text-gray-900">
                    Status<SortIcon field="status" />
                  </button>
                </th>
                {isAdmin && (
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Assigned to</th>
                )}
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  <button onClick={() => handleSort('open_count')} className="flex items-center hover:text-gray-900">
                    Engagement<SortIcon field="open_count" />
                  </button>
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  <button onClick={() => handleSort('last_activity_at')} className="flex items-center hover:text-gray-900">
                    Last activity<SortIcon field="last_activity_at" />
                  </button>
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Last call</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {visible.map(lead => {
                const sc = STATUS_COLORS[lead.status] ?? { bg: 'bg-gray-100', text: 'text-gray-600' }
                const dc = lead.last_call_disposition
                  ? (DISPOSITION_COLORS[lead.last_call_disposition] ?? { bg: 'bg-gray-100', text: 'text-gray-600' })
                  : null
                return (
                  <tr
                    key={lead.id}
                    onClick={() => router.push(`/sales/${lead.id}`)}
                    className="hover:bg-red-50 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3">
                      <span className="font-medium text-gray-900">
                        {lead.customer_name}
                      </span>
                      {lead.account_number && (
                        <div className="text-xs text-gray-400">#{lead.account_number}</div>
                      )}
                      {(lead.customer_city || lead.customer_state) && (
                        <div className="text-xs text-gray-400">
                          {[lead.customer_city, lead.customer_state].filter(Boolean).join(', ')}
                        </div>
                      )}
                      {lead.phone && (
                        <a
                          href={`tel:${lead.phone}`}
                          className="text-xs text-blue-600 hover:text-blue-800"
                          onClick={e => e.stopPropagation()}
                        >
                          {lead.phone}
                        </a>
                      )}
                      {lead.last_serviced_date && (
                        <div className="text-xs text-gray-400">
                          Last service: {new Date(lead.last_serviced_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {lead.tag_name && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700 mb-0.5">
                          {lead.tag_name}
                        </span>
                      )}
                      {lead.campaign_subject && (
                        <div className="text-xs text-gray-500 max-w-[200px] truncate">
                          {lead.campaign_subject}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge label={lead.status} bg={sc.bg} text={sc.text} />
                      {lead.status === 'Closed Won' && !lead.sf_job_created && (
                        <div className="text-xs text-orange-600 mt-0.5">Awaiting SF job</div>
                      )}
                    </td>
                    {isAdmin && (
                      <td className="px-4 py-3 text-sm text-gray-700">
                        {lead.assigned_rep_name ?? (
                          <span className="text-gray-400 text-xs">Unassigned</span>
                        )}
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <span className="text-gray-700 text-xs">
                        {lead.open_count} open{lead.open_count !== 1 ? 's' : ''}
                        {lead.click_count > 0 && ` · ${lead.click_count} click${lead.click_count !== 1 ? 's' : ''}`}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <AgingDot days={lead.days_since_activity} />
                    </td>
                    <td className="px-4 py-3">
                      {dc ? (
                        <Badge label={lead.last_call_disposition!} bg={dc.bg} text={dc.text} />
                      ) : (
                        <span className="text-gray-400 text-xs">—</span>
                      )}
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
