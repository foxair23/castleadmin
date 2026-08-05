'use client'

import { useState, useMemo, useTransition, Fragment } from 'react'
import { useRouter } from 'next/navigation'
import { setLeadGenEnabled, setLeadGenReplyTo, updateLeadStatus, sendOutreachNow } from './actions'

export interface LeadView {
  id: string
  provider: string
  customerName: string | null
  phone: string | null
  email: string | null
  address: string | null
  program: string | null
  source: string | null
  externalId: string | null
  referralStore: string | null
  leadNotes: string | null
  rawEmail: string | null
  receivedAt: string
  status: string
  heldReason: string | null
  emailSent: boolean
  smsSent: boolean
  smsStatus: string | null
  replyText: string | null
  jobNumber: string | null
  convertedAt: string | null
  needsAction: boolean
  acknowledgedAt: string | null
  sfCustomerId: string | null
}

export interface InboundEvent {
  id: string
  receivedAt: string
  from: string | null
  subject: string | null
  outcome: string
  detail: string | null
}

const PROVIDER_LABEL: Record<string, string> = { home_depot: 'Home Depot' }

function fmtDateTime(s: string): string {
  const d = new Date(s)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function StatusBadge({ status, needsAction, acknowledged }: { status: string; needsAction: boolean; acknowledged?: boolean }) {
  const map: Record<string, { label: string; cls: string }> = {
    new: { label: 'New', cls: 'bg-gray-100 text-gray-700' },
    held: { label: 'Held — review', cls: 'bg-amber-100 text-amber-800' },
    contacted: { label: 'Contacted', cls: 'bg-blue-50 text-blue-700' },
    no_contact: { label: 'No contact info', cls: 'bg-orange-100 text-orange-800' },
    callback: { label: 'Callback requested', cls: 'bg-purple-100 text-purple-800' },
    not_interested: { label: 'Not interested', cls: 'bg-gray-200 text-gray-500' },
    booked: { label: 'Booked', cls: 'bg-green-100 text-green-800' },
    duplicate: { label: 'Duplicate', cls: 'bg-gray-100 text-gray-400' },
  }
  const s = map[status] ?? { label: status, cls: 'bg-gray-100 text-gray-700' }
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${s.cls}`}>{s.label}</span>
      {needsAction && status !== 'callback' && <span title="Not booked within 1 hour" className="inline-block h-2 w-2 rounded-full bg-red-500" />}
      {acknowledged && !['booked', 'not_interested', 'duplicate'].includes(status) && (
        <span title="Handled via Action Items (Done)" className="text-green-600 text-xs">✓ handled</span>
      )}
    </span>
  )
}

type Filter = 'action' | 'all' | 'open' | 'booked' | 'closed'

export default function LeadGenClient({ leads, enabled, replyTo, inbound, canConfigure = true }: { leads: LeadView[]; enabled: boolean; replyTo: string; inbound: InboundEvent[]; canConfigure?: boolean }) {
  const router = useRouter()
  const [filter, setFilter] = useState<Filter>('action')
  const [pending, startTransition] = useTransition()
  const [replyToInput, setReplyToInput] = useState(replyTo)
  const [replySaved, setReplySaved] = useState(false)
  const [showInbound, setShowInbound] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const stats = useMemo(() => {
    const real = leads.filter(l => l.status !== 'duplicate')
    const booked = real.filter(l => l.status === 'booked').length
    return {
      total: real.length,
      needsAction: real.filter(l => l.needsAction).length,
      booked,
      convRate: real.length ? Math.round((booked / real.length) * 100) : 0,
    }
  }, [leads])

  const shown = useMemo(() => leads.filter(l => {
    switch (filter) {
      case 'action': return l.needsAction
      case 'open': return ['new', 'held', 'contacted', 'no_contact', 'callback'].includes(l.status)
      case 'booked': return l.status === 'booked'
      case 'closed': return ['not_interested', 'duplicate'].includes(l.status)
      default: return true
    }
  }), [leads, filter])

  function toggleEnabled() {
    startTransition(async () => { await setLeadGenEnabled(!enabled); router.refresh() })
  }
  function mark(id: string, status: 'not_interested' | 'booked' | 'contacted') {
    startTransition(async () => { await updateLeadStatus(id, status); router.refresh() })
  }
  function resend(id: string) {
    startTransition(async () => { await sendOutreachNow(id); router.refresh() })
  }
  function saveReplyTo() {
    startTransition(async () => { await setLeadGenReplyTo(replyToInput); setReplySaved(true); setTimeout(() => setReplySaved(false), 2000); router.refresh() })
  }

  const TABS: { key: Filter; label: string }[] = [
    { key: 'action', label: `Needs Action (${stats.needsAction})` },
    { key: 'open', label: 'Open' },
    { key: 'booked', label: 'Booked' },
    { key: 'closed', label: 'Closed' },
    { key: 'all', label: 'All' },
  ]

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900">LeadGen</h1>
          <p className="text-sm text-gray-500">Inbound provider leads → auto outreach → booking.</p>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-sm font-medium ${enabled ? 'text-green-700' : 'text-gray-500'}`}>
            Auto-send {enabled ? 'ON' : 'OFF'}
          </span>
          {canConfigure ? (
            <button
              onClick={toggleEnabled}
              disabled={pending}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${enabled ? 'bg-green-600' : 'bg-gray-300'} disabled:opacity-50`}
              title={enabled ? 'Auto-send is on — new leads are contacted immediately' : 'Auto-send is off — leads are recorded but not contacted'}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          ) : (
            <span
              className={`relative inline-flex h-6 w-11 items-center rounded-full opacity-60 cursor-not-allowed ${enabled ? 'bg-green-600' : 'bg-gray-300'}`}
              title="Only an admin can turn auto-send on or off"
              aria-disabled="true"
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </span>
          )}
        </div>
      </div>

      {!enabled && (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          Auto-send is <strong>off</strong>. Incoming leads are still recorded, but no email/SMS goes out until you turn it on.
        </div>
      )}

      {/* Reply-To: customer replies to the outreach email must reach a human,
          not the inbound webhook. Admin-only to configure; sales sees it read-only. */}
      <div className="mb-4 rounded-lg border border-gray-200 bg-white px-4 py-3">
        <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Outreach reply-to inbox</label>
        {canConfigure ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="email"
                value={replyToInput}
                onChange={e => setReplyToInput(e.target.value)}
                placeholder="e.g. vanessa@castlegaragedoors.com"
                className="flex-1 min-w-[220px] rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900"
              />
              <button onClick={saveReplyTo} disabled={pending} className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">Save</button>
              {replySaved && <span className="text-sm text-green-700">Saved</span>}
            </div>
            <p className="mt-1 text-xs text-gray-500">
              The outreach email invites customers to reply. Set a monitored inbox here — <strong>not</strong> an <code>@updates.castlegaragedoors.com</code> address, or replies loop back into the inbound webhook.
            </p>
          </>
        ) : (
          <>
            <p className="text-sm text-gray-900">{replyTo || <span className="text-gray-400">Not set</span>}</p>
            <p className="mt-1 text-xs text-gray-500">Customer replies to outreach emails go here. Contact an admin to change it.</p>
          </>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat label="Total leads" value={stats.total} />
        <Stat label="Needs action" value={stats.needsAction} accent={stats.needsAction > 0 ? 'red' : undefined} />
        <Stat label="Booked" value={stats.booked} accent="green" />
        <Stat label="Conversion" value={`${stats.convRate}%`} />
      </div>

      <div className="flex flex-wrap gap-2 mb-3">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setFilter(t.key)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium ${filter === t.key ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto border border-gray-200 rounded-lg">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <Th>Received</Th><Th>Customer</Th><Th>Contact</Th><Th>Program</Th><Th>Status</Th><Th>Job</Th><Th>Actions</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {shown.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">No leads in this view.</td></tr>
            )}
            {shown.map(l => (
              <Fragment key={l.id}>
              <tr className="hover:bg-gray-50 align-top cursor-pointer" onClick={() => setExpandedId(id => id === l.id ? null : l.id)}>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                  {fmtDateTime(l.receivedAt)}
                  <div className="text-[11px] text-gray-400">{PROVIDER_LABEL[l.provider] ?? l.provider}</div>
                </td>
                <td className="px-3 py-2">
                  <div className="font-medium text-gray-900">
                    <span className="text-gray-400 mr-1">{expandedId === l.id ? '▾' : '▸'}</span>
                    {l.customerName ?? '—'}
                    {l.sfCustomerId && <span className="ml-1.5 inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-800" title={`SF customer ${l.sfCustomerId}`}>✓ In SF</span>}
                  </div>
                  {l.address && <div className="text-[11px] text-gray-400 max-w-[220px]">{l.address}</div>}
                </td>
                <td className="px-3 py-2 text-gray-700">
                  {l.phone && (
                    <div title={l.smsSent ? (l.smsStatus === 'failed' ? 'Text failed' : 'Text sent') : 'No text sent'}>
                      📱 {l.phone} {l.smsSent && (l.smsStatus === 'failed' ? '⚠️' : '✓')}
                    </div>
                  )}
                  {l.email && (
                    <div title={l.emailSent ? 'Email sent' : 'No email sent'} className="max-w-[200px] truncate">
                      ✉ {l.email} {l.emailSent && '✓'}
                    </div>
                  )}
                  {!l.phone && !l.email && <span className="text-gray-300">—</span>}
                  {l.replyText && <div className="text-[11px] text-purple-600 mt-0.5">Reply: “{l.replyText}”</div>}
                </td>
                <td className="px-3 py-2 text-gray-600">{l.program ?? '—'}</td>
                <td className="px-3 py-2">
                  <StatusBadge status={l.status} needsAction={l.needsAction} acknowledged={!!l.acknowledgedAt} />
                  {l.heldReason && l.status === 'held' && <div className="text-[11px] text-amber-700 mt-0.5 max-w-[180px]">{l.heldReason}</div>}
                </td>
                <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{l.jobNumber ? `#${l.jobNumber}` : '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap" onClick={e => e.stopPropagation()}>
                  <div className="flex flex-col gap-1">
                    {l.status === 'held' && (
                      <button onClick={() => resend(l.id)} disabled={pending} className="text-[12px] font-medium text-red-600 hover:underline disabled:opacity-50">Send outreach</button>
                    )}
                    {['contacted', 'no_contact', 'callback', 'new'].includes(l.status) && (
                      <button onClick={() => resend(l.id)} disabled={pending} className="text-[12px] font-medium text-gray-600 hover:underline disabled:opacity-50">Re-send</button>
                    )}
                    {l.status !== 'booked' && l.status !== 'not_interested' && l.status !== 'duplicate' && (
                      <button onClick={() => mark(l.id, 'not_interested')} disabled={pending} className="text-[12px] text-gray-500 hover:underline disabled:opacity-50">Mark not interested</button>
                    )}
                  </div>
                </td>
              </tr>
              {expandedId === l.id && (
                <tr className="bg-gray-50">
                  <td colSpan={7} className="px-4 py-3">
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-sm">
                      <Detail label="Name" value={l.customerName} />
                      <Detail label="Phone" value={l.phone} />
                      <Detail label="Email" value={l.email} />
                      <Detail label="Address" value={l.address} />
                      <Detail label="Program" value={l.program} />
                      <Detail label="Source" value={l.source} />
                      <Detail label="Service Center ID" value={l.externalId} />
                      <Detail label="Referral Store" value={l.referralStore} />
                      <Detail label="Notes" value={l.leadNotes} />
                    </div>
                    {l.rawEmail && (
                      <details className="mt-3">
                        <summary className="text-xs font-medium text-gray-500 cursor-pointer">Raw email</summary>
                        <pre className="mt-1 max-h-64 overflow-auto rounded border border-gray-200 bg-white p-2 text-[11px] text-gray-700 whitespace-pre-wrap">{l.rawEmail}</pre>
                      </details>
                    )}
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* Inbound webhook log — what actually arrived at /api/leads/inbound. */}
      <div className="mt-6">
        <button onClick={() => setShowInbound(s => !s)} className="text-sm font-medium text-gray-600 hover:text-gray-900">
          {showInbound ? '▾' : '▸'} Recent inbound emails ({inbound.length})
        </button>
        {showInbound && (
          <div className="mt-2 overflow-x-auto border border-gray-200 rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr><Th>Received</Th><Th>From</Th><Th>Subject</Th><Th>Outcome</Th><Th>Detail</Th></tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {inbound.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-400">Nothing received yet.</td></tr>}
                {inbound.map(e => (
                  <tr key={e.id} className="hover:bg-gray-50 align-top">
                    <td className="px-3 py-2 whitespace-nowrap text-gray-600">{fmtDateTime(e.receivedAt)}</td>
                    <td className="px-3 py-2 text-gray-600"><div className="max-w-[180px] truncate">{e.from ?? '—'}</div></td>
                    <td className="px-3 py-2 text-gray-600"><div className="max-w-[220px] truncate">{e.subject ?? '—'}</div></td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        ['contacted', 'new', 'no_contact'].includes(e.outcome) ? 'bg-green-50 text-green-700'
                        : e.outcome === 'held' ? 'bg-amber-100 text-amber-800'
                        : ['error', 'fetch_failed'].includes(e.outcome) ? 'bg-red-100 text-red-700'
                        : 'bg-gray-100 text-gray-500'}`}>{e.outcome}</span>
                    </td>
                    <td className="px-3 py-2 text-gray-500"><div className="max-w-[220px] truncate" title={e.detail ?? undefined}>{e.detail ?? '—'}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, accent }: { label: string; value: string | number; accent?: 'red' | 'green' }) {
  const color = accent === 'red' ? 'text-red-600' : accent === 'green' ? 'text-green-700' : 'text-gray-900'
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
    </div>
  )
}

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-gray-400">{label}</div>
      <div className="text-gray-800 break-words">{value || <span className="text-gray-300">—</span>}</div>
    </div>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">{children}</th>
}
