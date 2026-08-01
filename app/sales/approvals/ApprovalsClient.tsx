'use client'

import { useState } from 'react'
import { lookupJob, refreshJob, sendApproval } from './actions'
import type { JobApprovalContext } from '@/lib/approvals/contact'

export interface ApprovalRow {
  id: string
  source_id: string
  customer_name: string | null
  amount_total: number | null
  status: 'pending' | 'approved' | 'declined' | 'expired'
  approved_name: string | null
  approved_at: string | null
  created_at: string
  sent_channels: string[] | null
  ip: string | null
}

function fmtCurrency(n: number | null): string {
  if (n == null) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
}
function fmtDateTime(s: string | null): string {
  if (!s) return '—'
  const d = new Date(s)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800',
  approved: 'bg-green-100 text-green-800',
  declined: 'bg-red-100 text-red-800',
  expired: 'bg-gray-100 text-gray-600',
}

export default function ApprovalsClient({ initialRows }: { initialRows: ApprovalRow[] }) {
  const [rows] = useState<ApprovalRow[]>(initialRows)

  // Lookup + send form state
  const [query, setQuery] = useState('')
  const [looking, setLooking] = useState(false)
  const [ctx, setCtx] = useState<JobApprovalContext | null>(null)
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [channel, setChannel] = useState<'email' | 'sms' | 'both'>('both')
  const [sending, setSending] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  function applyCtx(next: JobApprovalContext) {
    setCtx(next)
    setEmail(next.email ?? '')
    setPhone(next.phone ?? '')
    setCustomerName(next.contactName ?? next.customerName ?? '')
  }

  async function handleLookup() {
    setError(''); setNotice(''); setCtx(null)
    const q = query.trim()
    if (!q) { setError('Enter a job number.'); return }
    setLooking(true)
    try {
      const res = await lookupJob(q)
      if (!res.ok) { setError(res.error); return }
      applyCtx(res.ctx)
    } catch {
      setError('Lookup failed.')
    } finally {
      setLooking(false)
    }
  }

  async function handleRefresh() {
    if (!ctx) return
    setError(''); setNotice('')
    setRefreshing(true)
    try {
      const res = await refreshJob(ctx.jobId)
      if (!res.ok) { setError(res.error); return }
      applyCtx(res.ctx)
      setNotice('Pulled the latest from Service Fusion.')
    } catch {
      setError('Refresh failed.')
    } finally {
      setRefreshing(false)
    }
  }

  async function handleSend() {
    if (!ctx) return
    setError(''); setNotice('')
    setSending(true)
    try {
      const res = await sendApproval({
        jobId: ctx.jobId,
        channel,
        email: email.trim() || null,
        phone: phone.trim() || null,
        customerName: customerName.trim() || null,
      })
      if (!res.ok) { setError(res.error); return }
      setNotice(`Sent via ${res.sent.join(' + ')}.${res.warning ? ` (${res.warning})` : ''} Refresh to see it in the log.`)
      setCtx(null); setQuery('')
    } catch {
      setError('Send failed.')
    } finally {
      setSending(false)
    }
  }

  const total = ctx ? ctx.lineItems.reduce((s, it) => s + (it.total ?? 0), 0) : 0

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-gray-900">Customer Approvals</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Send a customer a link to review and approve their itemized quote before work begins.
        </p>
      </div>

      {/* Send form */}
      <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
        <div className="flex items-end gap-2">
          <div className="flex-1 max-w-xs">
            <label className="block text-sm text-gray-600 mb-1">Service Fusion job number</label>
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleLookup() }}
              placeholder="e.g. 12345"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-400"
            />
          </div>
          <button
            onClick={handleLookup}
            disabled={looking}
            className="bg-gray-800 hover:bg-gray-900 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-md"
          >
            {looking ? 'Looking…' : 'Look up'}
          </button>
        </div>

        {error && <div className="bg-red-50 border border-red-200 rounded px-4 py-2 text-sm text-red-600">{error}</div>}
        {notice && <div className="bg-green-50 border border-green-200 rounded px-4 py-2 text-sm text-green-700">{notice}</div>}

        {ctx && (
          <div className="border-t border-gray-100 pt-4 space-y-4">
            {/* Line items preview */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Job {ctx.jobNumber ?? ctx.jobId} — {ctx.customerName ?? 'Customer'}
                </p>
                <button
                  onClick={handleRefresh}
                  disabled={refreshing}
                  title="Pull the latest line items, customer, and total from Service Fusion"
                  className="text-xs text-gray-600 hover:text-gray-900 disabled:opacity-50 border border-gray-300 rounded px-2 py-1"
                >
                  {refreshing ? 'Refreshing…' : '↻ Refresh from Service Fusion'}
                </button>
              </div>
              <p className="text-xs text-gray-400 mb-2">
                Need to fix something? Update the job in Service Fusion, then Refresh to pull it in.
              </p>
              {ctx.lineItems.length === 0 ? (
                <p className="text-sm text-red-600">
                  No line items are mirrored for this job yet. It can&apos;t be sent until the job syncs.
                </p>
              ) : (
                <table className="w-full text-sm border border-gray-100 rounded">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase">Item</th>
                      <th className="text-right px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase">Qty</th>
                      <th className="text-right px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase">Unit</th>
                      <th className="text-right px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {ctx.lineItems.map((it, i) => (
                      <tr key={i}>
                        <td className="px-3 py-1.5 text-gray-900">{it.name ?? it.description ?? '—'}</td>
                        <td className="px-3 py-1.5 text-right text-gray-600">{it.quantity ?? ''}</td>
                        <td className="px-3 py-1.5 text-right text-gray-600">{it.unit_price != null ? fmtCurrency(it.unit_price) : ''}</td>
                        <td className="px-3 py-1.5 text-right font-medium text-gray-900">{it.total != null ? fmtCurrency(it.total) : ''}</td>
                      </tr>
                    ))}
                    <tr className="bg-gray-50">
                      <td colSpan={3} className="px-3 py-1.5 text-right font-semibold text-gray-700">Total</td>
                      <td className="px-3 py-1.5 text-right font-bold text-red-700">{fmtCurrency(total)}</td>
                    </tr>
                  </tbody>
                </table>
              )}
            </div>

            {/* Recipient — pre-filled from the mirror, editable (contact data can be stale/missing) */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-sm text-gray-600 mb-1">Customer name</label>
                <input type="text" value={customerName} onChange={e => setCustomerName(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-400" />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Email</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="customer@example.com"
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-400" />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Mobile</label>
                <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="(760) 555-1234"
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-400" />
              </div>
            </div>

            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-600">Send via</span>
                {(['both', 'email', 'sms'] as const).map(c => (
                  <label key={c} className="flex items-center gap-1 text-sm text-gray-800">
                    <input type="radio" name="channel" checked={channel === c} onChange={() => setChannel(c)} />
                    <span className="capitalize">{c === 'both' ? 'Email + SMS' : c}</span>
                  </label>
                ))}
              </div>
              <button
                onClick={handleSend}
                disabled={sending || ctx.lineItems.length === 0}
                className="ml-auto bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-medium px-6 py-2 rounded-md"
              >
                {sending ? 'Sending…' : 'Send approval request'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Log */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Job</th>
              <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Customer</th>
              <th className="px-4 py-2 text-right text-xs font-semibold text-gray-500 uppercase tracking-wide">Amount</th>
              <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
              <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Signed</th>
              <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Approved (PT)</th>
              <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Sent</th>
              <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">IP</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-400">No approval requests yet.</td></tr>
            ) : rows.map(r => (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="px-4 py-2 font-medium text-gray-900 whitespace-nowrap">{r.source_id}</td>
                <td className="px-4 py-2 text-gray-600 whitespace-nowrap">{r.customer_name ?? '—'}</td>
                <td className="px-4 py-2 text-right text-gray-600">{fmtCurrency(r.amount_total)}</td>
                <td className="px-4 py-2">
                  <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[r.status] ?? ''}`}>{r.status}</span>
                </td>
                <td className="px-4 py-2 text-gray-900">{r.approved_name ?? '—'}</td>
                <td className="px-4 py-2 text-gray-600 whitespace-nowrap">{fmtDateTime(r.approved_at)}</td>
                <td className="px-4 py-2 text-gray-500">{(r.sent_channels ?? []).join(', ') || '—'}</td>
                <td className="px-4 py-2 text-gray-400 whitespace-nowrap">{r.ip ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
