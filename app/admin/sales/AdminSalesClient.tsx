'use client'

import { useState, useTransition } from 'react'
import {
  toggleCampaignTracked,
  addPipelineStatus, renamePipelineStatus, deletePipelineStatus, movePipelineStatus,
  addCallDisposition, renameCallDisposition, deleteCallDisposition,
  bulkAssignLeads,
  linkEngagementToCustomer, dismissEngagement, searchCustomers,
} from './actions'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Campaign {
  mailchimp_campaign_id: string
  subject: string | null
  tag_name: string | null
  send_time: string | null
  total_recipients: number | null
  total_opens: number | null
  total_clicks: number | null
  is_tracked: boolean
  last_synced_at: string | null
}

interface PipelineStatus { id: string; name: string; sort_order: number; is_active: boolean }
interface CallDisposition { id: string; name: string; sort_order: number; is_active: boolean }

interface UnmatchedEngagement {
  id: string
  mailchimp_campaign_id: string
  email: string
  open_count: number
  click_count: number
  first_opened_at: string | null
  campaign_subject: string | null
}

interface Rep { id: string; full_name: string; role: string }

interface Props {
  campaigns: Campaign[]
  pipelineStatuses: PipelineStatus[]
  callDispositions: CallDisposition[]
  unmatched: UnmatchedEngagement[]
  reps: Rep[]
  tags: string[]
  statusUsageCounts: Record<string, number>
}

type Tab = 'campaigns' | 'pipeline' | 'assign' | 'unmatched'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null | undefined) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden mb-6">
      <div className="px-5 py-3 border-b border-gray-100 bg-gray-50">
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">{title}</h2>
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  )
}

// ─── Inline rename input ──────────────────────────────────────────────────────

function InlineRename({
  initialValue,
  onSave,
}: {
  initialValue: string
  onSave: (val: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(initialValue)
  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="text-left hover:text-red-600 transition-colors"
      >
        {val}
      </button>
    )
  }
  return (
    <input
      autoFocus
      value={val}
      onChange={e => setVal(e.target.value)}
      onBlur={() => { setEditing(false); if (val.trim() && val !== initialValue) onSave(val) }}
      onKeyDown={e => { if (e.key === 'Enter') { setEditing(false); if (val.trim()) onSave(val) } if (e.key === 'Escape') { setVal(initialValue); setEditing(false) } }}
      className="border border-gray-300 rounded px-2 py-0.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500 w-48"
    />
  )
}

// ─── Campaigns tab ────────────────────────────────────────────────────────────

function CampaignsTab({ campaigns }: { campaigns: Campaign[] }) {
  const [, startTransition] = useTransition()

  function toggle(id: string, current: boolean) {
    startTransition(async () => {
      await toggleCampaignTracked(id, !current)
    })
  }

  if (campaigns.length === 0) {
    return <p className="text-sm text-gray-400 py-4">No campaigns yet — sync from Mailchimp first.</p>
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 border-b border-gray-100">
            <th className="pb-2 font-medium pr-4">Subject</th>
            <th className="pb-2 font-medium pr-4">Tag</th>
            <th className="pb-2 font-medium pr-4">Sent</th>
            <th className="pb-2 font-medium pr-4 text-right">Recipients</th>
            <th className="pb-2 font-medium pr-4 text-right">Opens</th>
            <th className="pb-2 font-medium pr-4 text-right">Clicks</th>
            <th className="pb-2 font-medium pr-4">Last synced</th>
            <th className="pb-2 font-medium">Tracked</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {campaigns.map(c => (
            <tr key={c.mailchimp_campaign_id} className="hover:bg-gray-50">
              <td className="py-2 pr-4 text-gray-900 max-w-[220px] truncate">{c.subject ?? '—'}</td>
              <td className="py-2 pr-4">
                {c.tag_name
                  ? <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700">{c.tag_name}</span>
                  : <span className="text-gray-400 text-xs">—</span>
                }
              </td>
              <td className="py-2 pr-4 text-gray-600 whitespace-nowrap">{fmtDate(c.send_time)}</td>
              <td className="py-2 pr-4 text-right text-gray-700">{c.total_recipients ?? '—'}</td>
              <td className="py-2 pr-4 text-right text-gray-700">{c.total_opens ?? '—'}</td>
              <td className="py-2 pr-4 text-right text-gray-700">{c.total_clicks ?? '—'}</td>
              <td className="py-2 pr-4 text-gray-500 whitespace-nowrap text-xs">{fmtDate(c.last_synced_at)}</td>
              <td className="py-2">
                <button
                  onClick={() => toggle(c.mailchimp_campaign_id, c.is_tracked)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                    c.is_tracked
                      ? 'bg-green-100 text-green-800 hover:bg-green-200'
                      : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                  }`}
                >
                  {c.is_tracked ? 'Tracked' : 'Untracked'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Pipeline config tab ──────────────────────────────────────────────────────

function EditableList({
  items,
  usageCounts,
  onAdd,
  onRename,
  onDelete,
  onMove,
  placeholder,
}: {
  items: { id: string; name: string; sort_order: number; is_active: boolean }[]
  usageCounts?: Record<string, number>
  onAdd: (name: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  onMove: (id: string, dir: 'up' | 'down') => void
  placeholder: string
}) {
  const [newName, setNewName] = useState('')
  const [, startTransition] = useTransition()
  const active = items.filter(i => i.is_active)

  function handleAdd() {
    if (!newName.trim()) return
    startTransition(async () => { await onAdd(newName); setNewName('') })
  }

  return (
    <div className="space-y-1">
      {active.map((item, idx) => {
        const count = usageCounts?.[item.name] ?? 0
        return (
          <div key={item.id} className="flex items-center gap-2 py-1">
            <div className="flex flex-col gap-0.5">
              <button
                onClick={() => startTransition(async () => { await onMove(item.id, 'up') })}
                disabled={idx === 0}
                className="text-gray-300 hover:text-gray-600 disabled:opacity-20 text-xs leading-none"
              >▲</button>
              <button
                onClick={() => startTransition(async () => { await onMove(item.id, 'down') })}
                disabled={idx === active.length - 1}
                className="text-gray-300 hover:text-gray-600 disabled:opacity-20 text-xs leading-none"
              >▼</button>
            </div>
            <InlineRename
              initialValue={item.name}
              onSave={v => startTransition(async () => { await onRename(item.id, v) })}
            />
            {usageCounts && (
              <span className="text-xs text-gray-400 ml-1">({count} lead{count !== 1 ? 's' : ''})</span>
            )}
            <button
              onClick={() => {
                if (count > 0) return
                startTransition(async () => { await onDelete(item.id) })
              }}
              disabled={count > 0}
              title={count > 0 ? `In use by ${count} lead${count !== 1 ? 's' : ''} — cannot delete` : 'Delete'}
              className="ml-auto text-gray-300 hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm"
            >
              ✕
            </button>
          </div>
        )
      })}
      <div className="flex gap-2 mt-3 pt-3 border-t border-gray-100">
        <input
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
          placeholder={placeholder}
          className="flex-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500"
        />
        <button
          onClick={handleAdd}
          disabled={!newName.trim()}
          className="px-3 py-1.5 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
        >
          Add
        </button>
      </div>
    </div>
  )
}

function PipelineTab({
  pipelineStatuses,
  callDispositions,
  statusUsageCounts,
}: {
  pipelineStatuses: PipelineStatus[]
  callDispositions: CallDisposition[]
  statusUsageCounts: Record<string, number>
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <Section title="Pipeline statuses">
        <EditableList
          items={pipelineStatuses}
          usageCounts={statusUsageCounts}
          onAdd={addPipelineStatus}
          onRename={renamePipelineStatus}
          onDelete={deletePipelineStatus}
          onMove={movePipelineStatus}
          placeholder="New status name…"
        />
      </Section>
      <Section title="Call dispositions">
        <EditableList
          items={callDispositions}
          onAdd={addCallDisposition}
          onRename={renameCallDisposition}
          onDelete={deleteCallDisposition}
          onMove={(id, dir) => {
            // dispositions don't have a move action wired up — reuse same pattern
            void id; void dir
          }}
          placeholder="New disposition name…"
        />
      </Section>
    </div>
  )
}

// ─── Bulk assign tab ──────────────────────────────────────────────────────────

function AssignTab({
  campaigns,
  reps,
  tags,
}: {
  campaigns: Campaign[]
  reps: Rep[]
  tags: string[]
}) {
  const [campaignId, setCampaignId] = useState('')
  const [tagName, setTagName] = useState('')
  const [assigneeId, setAssigneeId] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function handleAssign() {
    if (!assigneeId) return
    setResult(null)
    startTransition(async () => {
      const res = await bulkAssignLeads(assigneeId, {
        campaignId: campaignId || undefined,
        tagName: tagName || undefined,
      })
      setResult(`Assigned ${res.assigned} lead${res.assigned !== 1 ? 's' : ''}.`)
    })
  }

  return (
    <Section title="Bulk assign unassigned leads">
      <p className="text-sm text-gray-500 mb-4">
        Assigns all currently <strong>unassigned</strong> leads matching the filters to the selected rep.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Campaign (optional)</label>
          <select
            value={campaignId}
            onChange={e => setCampaignId(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500"
          >
            <option value="">All campaigns</option>
            {campaigns.map(c => (
              <option key={c.mailchimp_campaign_id} value={c.mailchimp_campaign_id}>
                {c.subject ?? c.mailchimp_campaign_id}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Tag (optional)</label>
          <select
            value={tagName}
            onChange={e => setTagName(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500"
          >
            <option value="">All tags</option>
            {tags.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Assign to <span className="text-red-500">*</span></label>
          <select
            value={assigneeId}
            onChange={e => setAssigneeId(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500"
          >
            <option value="">— select rep —</option>
            {reps.map(r => (
              <option key={r.id} value={r.id}>{r.full_name} ({r.role})</option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex items-center gap-4">
        <button
          onClick={handleAssign}
          disabled={!assigneeId || pending}
          className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-60 transition-colors"
        >
          {pending ? 'Assigning…' : 'Assign leads'}
        </button>
        {result && <span className="text-sm text-green-700 font-medium">{result}</span>}
      </div>
    </Section>
  )
}

// ─── Unmatched engagements tab ────────────────────────────────────────────────

function UnmatchedRow({ eng }: { eng: UnmatchedEngagement }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ id: string; customer_name: string | null; account_number: string | null }[]>([])
  const [searching, setSearching] = useState(false)
  const [, startTransition] = useTransition()

  async function handleSearch() {
    setSearching(true)
    const res = await searchCustomers(query)
    setResults(res)
    setSearching(false)
  }

  return (
    <div className="border border-gray-100 rounded-lg px-4 py-3 space-y-2">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="text-sm font-medium text-gray-900">{eng.email}</p>
          {eng.campaign_subject && <p className="text-xs text-gray-500">{eng.campaign_subject}</p>}
          <p className="text-xs text-gray-400 mt-0.5">
            {eng.open_count} open{eng.open_count !== 1 ? 's' : ''}
            {eng.click_count > 0 && ` · ${eng.click_count} click${eng.click_count !== 1 ? 's' : ''}`}
            {eng.first_opened_at && ` · first opened ${fmtDate(eng.first_opened_at)}`}
          </p>
        </div>
        <button
          onClick={() => startTransition(async () => { await dismissEngagement(eng.id) })}
          className="text-xs text-gray-400 hover:text-red-500 transition-colors whitespace-nowrap"
        >
          Dismiss
        </button>
      </div>
      <div className="flex gap-2">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSearch() }}
          placeholder="Search customer by name or account #…"
          className="flex-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500"
        />
        <button
          onClick={handleSearch}
          disabled={searching || query.length < 2}
          className="px-3 py-1.5 bg-gray-100 text-gray-700 text-sm rounded-lg hover:bg-gray-200 disabled:opacity-50 transition-colors"
        >
          {searching ? '…' : 'Search'}
        </button>
      </div>
      {results.length > 0 && (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          {results.map(c => (
            <button
              key={c.id}
              onClick={() => startTransition(async () => { await linkEngagementToCustomer(eng.id, c.id) })}
              className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 border-b border-gray-100 last:border-0 transition-colors"
            >
              <span className="font-medium">{c.customer_name ?? c.id}</span>
              {c.account_number && <span className="text-gray-400 ml-2 text-xs">#{c.account_number}</span>}
            </button>
          ))}
        </div>
      )}
      {results.length === 0 && query.length >= 2 && !searching && (
        <p className="text-xs text-gray-400">No customers found.</p>
      )}
    </div>
  )
}

function UnmatchedTab({ unmatched }: { unmatched: UnmatchedEngagement[] }) {
  if (unmatched.length === 0) {
    return <p className="text-sm text-gray-400 py-4">No unmatched engagements — all openers have been linked to SF customers.</p>
  }
  return (
    <div>
      <p className="text-sm text-gray-500 mb-4">
        {unmatched.length} Mailchimp opener{unmatched.length !== 1 ? 's' : ''} could not be matched to an SF customer by email.
        Search for the customer to link them, or dismiss to remove from this list.
      </p>
      <div className="space-y-3">
        {unmatched.map(e => <UnmatchedRow key={e.id} eng={e} />)}
      </div>
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function AdminSalesClient({
  campaigns,
  pipelineStatuses,
  callDispositions,
  unmatched,
  reps,
  tags,
  statusUsageCounts,
}: Props) {
  const [tab, setTab] = useState<Tab>('campaigns')

  const tabs: { key: Tab; label: string }[] = [
    { key: 'campaigns', label: `Campaigns (${campaigns.length})` },
    { key: 'pipeline',  label: 'Pipeline Config' },
    { key: 'assign',    label: 'Bulk Assign' },
    { key: 'unmatched', label: `Unmatched (${unmatched.length})` },
  ]

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Pipeline</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Manage campaigns, pipeline config, rep assignment, and unmatched engagements.
          </p>
        </div>
        <a
          href="/sales"
          className="text-sm text-gray-500 hover:text-gray-900 transition-colors"
        >
          → Sales dashboard
        </a>
      </div>

      <div className="flex gap-1 mb-6 border-b border-gray-200">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
              tab === t.key
                ? 'border-red-600 text-red-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'campaigns' && <CampaignsTab campaigns={campaigns} />}
      {tab === 'pipeline'  && (
        <PipelineTab
          pipelineStatuses={pipelineStatuses}
          callDispositions={callDispositions}
          statusUsageCounts={statusUsageCounts}
        />
      )}
      {tab === 'assign'    && <AssignTab campaigns={campaigns} reps={reps} tags={tags} />}
      {tab === 'unmatched' && <UnmatchedTab unmatched={unmatched} />}
    </div>
  )
}
