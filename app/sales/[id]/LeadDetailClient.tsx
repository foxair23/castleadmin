'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { logCall, addNote, updateLeadStatus, markSfJobCreated } from './actions'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Lead {
  id: string
  customer_id: string
  mailchimp_campaign_id: string
  tag_name: string | null
  status: string
  assigned_to_user_id: string | null
  created_at: string
  first_opened_at: string | null
  last_opened_at: string | null
  open_count: number
  click_count: number
  last_activity_at: string | null
  closed_outcome: string | null
  sf_job_created: boolean
  sf_job_marked_created_at: string | null
}

interface Customer {
  id: string
  customer_name: string | null
  account_number: string | null
  account_balance: number | null
  referral_source: string | null
  last_serviced_date: string | null
  is_vip: boolean
}

interface Location {
  street_1: string | null
  street_2: string | null
  city: string | null
  state_prov: string | null
  postal_code: string | null
}

interface Equipment {
  id: string
  type: string | null
  make: string | null
  model: string | null
  location: string | null
  install_date: string | null
}

interface Job {
  id: string
  number: string | null
  start_date: string | null
  category: string | null
  total: number | null
  status_name: string | null
}

interface Campaign {
  mailchimp_campaign_id: string
  subject: string | null
  tag_name: string | null
  send_time: string | null
}

interface Call {
  id: string
  rep_name: string
  called_at: string
  disposition: string
  duration_minutes: number | null
  notes: string | null
}

interface Note {
  id: string
  rep_name: string
  body: string
  created_at: string
}

interface HistoryEntry {
  id: string
  rep_name: string | null
  from_status: string | null
  to_status: string
  changed_at: string
}

interface PipelineStatus { id: string; name: string }
interface Disposition { id: string; name: string }

interface Props {
  lead: Lead
  customer: Customer | null
  primaryLocation: Location | null
  phones: { phone: string; type: string | null }[]
  emails: string[]
  equipment: Equipment[]
  jobs: Job[]
  campaign: Campaign | null
  calls: Call[]
  notes: Note[]
  history: HistoryEntry[]
  pipelineStatuses: PipelineStatus[]
  callDispositions: Disposition[]
  assignedRepName: string | null
  lifetimeSpend: number
  isAdmin: boolean
  currentUserId: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  'New':         'bg-blue-100 text-blue-800',
  'Contacted':   'bg-yellow-100 text-yellow-800',
  'Engaged':     'bg-purple-100 text-purple-800',
  'Quoted':      'bg-orange-100 text-orange-800',
  'Closed Won':  'bg-green-100 text-green-800',
  'Closed Lost': 'bg-gray-100 text-gray-500',
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

function daysSince(iso: string | null | undefined): string {
  if (!iso) return '—'
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return '1 day ago'
  return `${days} days ago`
}

function fmtCurrency(n: number | null | undefined): string {
  if (n == null) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100 bg-gray-50">
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">{title}</h2>
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5 text-sm">
      <span className="w-40 shrink-0 text-gray-500">{label}</span>
      <span className="text-gray-900">{children}</span>
    </div>
  )
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <button
      onClick={copy}
      className="ml-2 text-xs text-gray-400 hover:text-gray-700 transition-colors"
      title="Copy"
    >
      {copied ? '✓' : '⎘'}
    </button>
  )
}

// ─── Log Call Modal ───────────────────────────────────────────────────────────

function LogCallModal({
  leadId,
  dispositions,
  currentStatus,
  onClose,
}: {
  leadId: string
  dispositions: Disposition[]
  currentStatus: string
  onClose: () => void
}) {
  const [disposition, setDisposition] = useState('')
  const [duration, setDuration] = useState('')
  const [notes, setNotes] = useState('')
  const [calledAt, setCalledAt] = useState(() => {
    const now = new Date()
    now.setSeconds(0, 0)
    return now.toISOString().slice(0, 16)
  })
  const [pending, startTransition] = useTransition()

  const willAdvanceStatus = (() => {
    if (!disposition) return null
    if (disposition === 'Closed Won') return 'Closed Won'
    if (disposition === 'Closed Lost') return 'Closed Lost'
    if (currentStatus === 'New') return 'Contacted'
    if ((currentStatus === 'New' || currentStatus === 'Contacted') && disposition === 'Connected') return 'Engaged'
    if (disposition === 'Quote Sent' && !['Quoted', 'Closed Won', 'Closed Lost'].includes(currentStatus)) return 'Quoted'
    return null
  })()

  function handleSave() {
    if (!disposition) return
    startTransition(async () => {
      await logCall(leadId, disposition, duration ? parseInt(duration) : null, notes, calledAt)
      onClose()
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4">
        <div className="px-6 py-4 border-b border-gray-100">
          <h3 className="text-base font-semibold text-gray-900">Log Call</h3>
        </div>
        <div className="px-6 py-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">When</label>
            <input
              type="datetime-local"
              value={calledAt}
              onChange={e => setCalledAt(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Disposition <span className="text-red-500">*</span></label>
            <select
              value={disposition}
              onChange={e => setDisposition(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500"
            >
              <option value="">— select —</option>
              {dispositions.map(d => (
                <option key={d.id} value={d.name}>{d.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Duration (minutes, optional)</label>
            <input
              type="number"
              min="1"
              value={duration}
              onChange={e => setDuration(e.target.value)}
              placeholder="e.g. 5"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500 resize-none"
              placeholder="What happened on this call?"
            />
          </div>
          {willAdvanceStatus && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
              This will move the lead to <strong>{willAdvanceStatus}</strong>.
            </div>
          )}
        </div>
        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!disposition || pending}
            className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-60 transition-colors"
          >
            {pending ? 'Saving…' : 'Save Call'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Add Note Modal ───────────────────────────────────────────────────────────

function AddNoteModal({ leadId, onClose }: { leadId: string; onClose: () => void }) {
  const [body, setBody] = useState('')
  const [pending, startTransition] = useTransition()

  function handleSave() {
    if (!body.trim()) return
    startTransition(async () => {
      await addNote(leadId, body)
      onClose()
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4">
        <div className="px-6 py-4 border-b border-gray-100">
          <h3 className="text-base font-semibold text-gray-900">Add Note</h3>
        </div>
        <div className="px-6 py-4">
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            rows={5}
            autoFocus
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500 resize-none"
            placeholder="Add a note about this lead…"
          />
        </div>
        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 transition-colors">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!body.trim() || pending}
            className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-60 transition-colors"
          >
            {pending ? 'Saving…' : 'Add Note'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function LeadDetailClient({
  lead,
  customer,
  primaryLocation,
  phones,
  emails,
  equipment,
  jobs,
  campaign,
  calls,
  notes,
  history,
  pipelineStatuses,
  callDispositions,
  assignedRepName,
  lifetimeSpend,
  isAdmin,
}: Props) {
  const [showLogCall, setShowLogCall] = useState(false)
  const [showAddNote, setShowAddNote] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [statusPending, startStatusTransition] = useTransition()
  const [sfPending, startSfTransition] = useTransition()

  const statusColor = STATUS_COLORS[lead.status] ?? 'bg-gray-100 text-gray-600'
  const isClosedWon = lead.status === 'Closed Won'

  function handleStatusChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const newStatus = e.target.value
    if (!newStatus || newStatus === lead.status) return
    startStatusTransition(async () => {
      await updateLeadStatus(lead.id, newStatus)
    })
  }

  function handleMarkSfCreated() {
    startSfTransition(async () => {
      await markSfJobCreated(lead.id)
    })
  }

  const address = primaryLocation
    ? [primaryLocation.street_1, primaryLocation.street_2, primaryLocation.city && `${primaryLocation.city}, ${primaryLocation.state_prov} ${primaryLocation.postal_code ?? ''}`.trim()].filter(Boolean).join('\n')
    : null

  return (
    <div className="space-y-5">
      {showLogCall && (
        <LogCallModal
          leadId={lead.id}
          dispositions={callDispositions}
          currentStatus={lead.status}
          onClose={() => setShowLogCall(false)}
        />
      )}
      {showAddNote && (
        <AddNoteModal leadId={lead.id} onClose={() => setShowAddNote(false)} />
      )}

      {/* Header */}
      <div className="bg-white rounded-lg border border-gray-200 px-5 py-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <Link href="/sales" className="text-sm text-gray-400 hover:text-gray-600">← Sales</Link>
            </div>
            <h1 className="text-xl font-bold text-gray-900">
              {customer?.customer_name ?? lead.customer_id}
              {customer?.is_vip && (
                <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-800">VIP</span>
              )}
            </h1>
            <div className="flex items-center gap-3 mt-1 text-sm text-gray-500 flex-wrap">
              {campaign?.tag_name && <span className="bg-gray-100 text-gray-700 px-2 py-0.5 rounded text-xs font-medium">{campaign.tag_name}</span>}
              <span>Created {fmtDate(lead.created_at)}</span>
              <span>Last activity {daysSince(lead.last_activity_at)}</span>
              {assignedRepName && <span>Rep: {assignedRepName}</span>}
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            {/* Status selector */}
            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${statusColor}`}>
                {lead.status}
              </span>
              <select
                onChange={handleStatusChange}
                disabled={statusPending}
                defaultValue=""
                className="text-sm text-gray-900 border border-gray-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-60"
              >
                <option value="" disabled>Change status…</option>
                {pipelineStatuses.map(s => (
                  <option key={s.id} value={s.name}>{s.name}</option>
                ))}
              </select>
            </div>

            <button
              onClick={() => setShowLogCall(true)}
              className="px-3 py-1.5 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 transition-colors"
            >
              Log Call
            </button>
            <button
              onClick={() => setShowAddNote(true)}
              className="px-3 py-1.5 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
            >
              Add Note
            </button>
          </div>
        </div>
      </div>

      {/* Closed Won — SF Handoff Banner */}
      {isClosedWon && (
        <div className={`rounded-lg border px-5 py-4 ${lead.sf_job_created ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'}`}>
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <p className={`text-sm font-semibold ${lead.sf_job_created ? 'text-green-800' : 'text-amber-800'}`}>
                {lead.sf_job_created ? '✓ SF job has been created' : 'Closed Won — Ready for Service Fusion Handoff'}
              </p>
              {!lead.sf_job_created && (
                <p className="text-xs text-amber-700 mt-1">
                  Search for this customer in SF by account number, then create the job under their record.
                </p>
              )}
              {lead.sf_job_created && lead.sf_job_marked_created_at && (
                <p className="text-xs text-green-700 mt-0.5">Marked {fmtDateTime(lead.sf_job_marked_created_at)}</p>
              )}
            </div>
            {!lead.sf_job_created && customer && (
              <div className="text-right space-y-1">
                {customer.account_number && (
                  <div className="text-sm">
                    <span className="text-amber-700 font-medium">Account #</span>{' '}
                    <span className="font-mono text-lg font-bold text-gray-900">{customer.account_number}</span>
                    <CopyButton value={customer.account_number} />
                  </div>
                )}
                <button
                  onClick={handleMarkSfCreated}
                  disabled={sfPending}
                  className="mt-2 px-3 py-1.5 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-60 transition-colors"
                >
                  {sfPending ? 'Marking…' : 'Mark SF job as created'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Customer summary */}
        <Section title="Customer">
          {customer ? (
            <>
              {customer.account_number && (
                <Row label="Account #">
                  <span className="font-mono">{customer.account_number}</span>
                  <CopyButton value={customer.account_number} />
                </Row>
              )}
              {address && (
                <Row label="Address">
                  <span className="whitespace-pre-line">{address}</span>
                  <CopyButton value={address.replace('\n', ', ')} />
                </Row>
              )}
              {phones.length > 0 && (
                <Row label="Phone">
                  <div className="space-y-0.5">
                    {phones.map((p, i) => (
                      <div key={i}>
                        <a href={`tel:${p.phone}`} className="hover:text-red-600">{p.phone}</a>
                        {p.type && <span className="text-gray-400 text-xs ml-1">({p.type})</span>}
                      </div>
                    ))}
                  </div>
                </Row>
              )}
              {emails.length > 0 && (
                <Row label="Email">
                  <div className="space-y-0.5">
                    {emails.map((e, i) => (
                      <div key={i}>{e}</div>
                    ))}
                  </div>
                </Row>
              )}
              <Row label="Last serviced">{fmtDate(customer.last_serviced_date)}</Row>
              <Row label="Account balance">
                {customer.account_balance != null
                  ? <span className={customer.account_balance < 0 ? 'text-red-600 font-medium' : ''}>{fmtCurrency(customer.account_balance)}</span>
                  : '—'
                }
              </Row>
              <Row label="Lifetime spend">{fmtCurrency(lifetimeSpend)}</Row>
              {customer.referral_source && <Row label="Referral source">{customer.referral_source}</Row>}
            </>
          ) : (
            <p className="text-sm text-gray-400">Customer not found in mirror.</p>
          )}
        </Section>

        {/* Engagement */}
        <Section title="Engagement">
          {campaign?.subject && <Row label="Campaign">{campaign.subject}</Row>}
          {campaign?.send_time && <Row label="Sent">{fmtDate(campaign.send_time)}</Row>}
          <Row label="Opens">
            {lead.open_count}
            {lead.first_opened_at && <span className="text-gray-400 text-xs ml-2">first {fmtDate(lead.first_opened_at)}</span>}
            {lead.last_opened_at && lead.last_opened_at !== lead.first_opened_at && (
              <span className="text-gray-400 text-xs ml-1">· last {fmtDate(lead.last_opened_at)}</span>
            )}
          </Row>
          <Row label="Clicks">{lead.click_count}</Row>
        </Section>
      </div>

      {/* Equipment */}
      {equipment.length > 0 && (
        <Section title="Equipment on file">
          <div className="space-y-2">
            {equipment.map(e => (
              <div key={e.id} className="text-sm">
                <span className="font-medium text-gray-900">
                  {[e.make, e.model].filter(Boolean).join(' ') || e.type || 'Unknown'}
                </span>
                {e.type && <span className="text-gray-400 ml-2 text-xs">{e.type}</span>}
                {e.location && <span className="text-gray-400 ml-2 text-xs">— {e.location}</span>}
                {e.install_date && <span className="text-gray-400 ml-2 text-xs">installed {fmtDate(e.install_date)}</span>}
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* SF Job history */}
      {jobs.length > 0 && (
        <Section title="Service Fusion history">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-100">
                  <th className="pb-2 font-medium pr-4">Date</th>
                  <th className="pb-2 font-medium pr-4">Job #</th>
                  <th className="pb-2 font-medium pr-4">Category</th>
                  <th className="pb-2 font-medium pr-4 text-right">Total</th>
                  <th className="pb-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {jobs.map(j => (
                  <tr key={j.id}>
                    <td className="py-1.5 pr-4 text-gray-700">{fmtDate(j.start_date)}</td>
                    <td className="py-1.5 pr-4 text-gray-500 font-mono text-xs">{j.number ?? '—'}</td>
                    <td className="py-1.5 pr-4 text-gray-700">{j.category ?? '—'}</td>
                    <td className="py-1.5 pr-4 text-gray-700 text-right">{j.total != null ? fmtCurrency(j.total) : '—'}</td>
                    <td className="py-1.5 text-gray-500 text-xs">{j.status_name ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Call log */}
      <Section title={`Call log (${calls.length})`}>
        <div className="mb-3">
          <button
            onClick={() => setShowLogCall(true)}
            className="px-3 py-1.5 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 transition-colors"
          >
            Log Call
          </button>
        </div>
        {calls.length === 0 ? (
          <p className="text-sm text-gray-400">No calls logged yet.</p>
        ) : (
          <div className="space-y-3">
            {calls.map(c => (
              <div key={c.id} className="border border-gray-100 rounded-lg px-4 py-3">
                <div className="flex items-center gap-3 flex-wrap mb-1">
                  <span className="text-sm font-medium text-gray-900">{c.rep_name}</span>
                  <span className="text-xs text-gray-400">{fmtDateTime(c.called_at)}</span>
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700">{c.disposition}</span>
                  {c.duration_minutes && <span className="text-xs text-gray-400">{c.duration_minutes} min</span>}
                </div>
                {c.notes && <p className="text-sm text-gray-700">{c.notes}</p>}
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Notes */}
      <Section title={`Notes (${notes.length})`}>
        <div className="mb-3">
          <button
            onClick={() => setShowAddNote(true)}
            className="px-3 py-1.5 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
          >
            Add Note
          </button>
        </div>
        {notes.length === 0 ? (
          <p className="text-sm text-gray-400">No notes yet.</p>
        ) : (
          <div className="space-y-3">
            {notes.map(n => (
              <div key={n.id} className="border border-gray-100 rounded-lg px-4 py-3">
                <div className="flex items-center gap-3 mb-1">
                  <span className="text-sm font-medium text-gray-900">{n.rep_name}</span>
                  <span className="text-xs text-gray-400">{fmtDateTime(n.created_at)}</span>
                </div>
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{n.body}</p>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Status history */}
      <div>
        <button
          onClick={() => setShowHistory(h => !h)}
          className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
        >
          {showHistory ? '▾' : '▸'} Status history ({history.length})
        </button>
        {showHistory && history.length > 0 && (
          <div className="mt-2 space-y-1.5 pl-4">
            {history.map(h => (
              <div key={h.id} className="text-sm text-gray-600">
                <span className="text-gray-400 mr-2">{fmtDateTime(h.changed_at)}</span>
                {h.from_status ? (
                  <><span>{h.from_status}</span><span className="mx-1 text-gray-400">→</span></>
                ) : null}
                <span className="font-medium">{h.to_status}</span>
                {h.rep_name && <span className="text-gray-400 ml-2">by {h.rep_name}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
