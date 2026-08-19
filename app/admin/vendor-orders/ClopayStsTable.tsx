'use client'

import { useMemo, useRef, useState, useTransition } from 'react'
import { useSearchParams } from 'next/navigation'
import { CLOPAY_STS_STAGES } from '@/lib/clopay-sts/stages'
import { setStsStatusAction, sendDcRequestAction, uploadStsAttachmentAction } from './actions'

export interface StsAttachment {
  id: string
  filename: string
  mime_type: string | null
  byte_size: number | null
  source: string
  url: string | null
}

export interface StsOrder {
  id: string
  external_id: string
  customer_po: string | null
  status: string
  details_requested_at: string | null
  details_received_at: string | null
  dc_reply_text: string | null
  first_seen_at: string
  attachments: StsAttachment[]
}

const fmtSeen = (s: string | null) =>
  s ? new Date(s).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'

const statusStyle = (s: string) => {
  if (s === 'Closed (invoiced/billed)') return 'bg-gray-100 text-gray-500'
  if (s === 'Delivered') return 'bg-green-100 text-green-800'
  if (s === 'Received') return 'bg-blue-100 text-blue-700'
  return 'bg-amber-100 text-amber-800'
}

function StatusSelect({ orderId, status }: { orderId: string; status: string }) {
  const [pending, start] = useTransition()
  const [val, setVal] = useState(status)
  const [err, setErr] = useState<string | null>(null)
  return (
    <span className="inline-flex flex-col gap-0.5">
      <select
        value={val}
        disabled={pending}
        onChange={e => {
          const next = e.target.value
          setVal(next); setErr(null)
          start(async () => { const r = await setStsStatusAction(orderId, next); if (!r.ok) { setErr(r.error ?? 'failed'); setVal(status) } })
        }}
        className={`text-gray-900 border border-gray-300 rounded-md px-2 py-1 text-xs bg-white ${statusStyle(val)}`}
      >
        {CLOPAY_STS_STAGES.map(s => <option key={s} value={s}>{s}</option>)}
      </select>
      {err && <span className="text-[10px] text-red-600">{err}</span>}
    </span>
  )
}

function DcRequestCell({ order }: { order: StsOrder }) {
  const [pending, start] = useTransition()
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  return (
    <span className="inline-flex flex-col gap-0.5">
      {order.details_requested_at ? (
        <span className="text-xs text-green-700" title={fmtSeen(order.details_requested_at)}>✓ sent {fmtSeen(order.details_requested_at)}</span>
      ) : (
        <span className="text-xs text-gray-400">not requested</span>
      )}
      <button
        type="button"
        disabled={pending}
        onClick={() => { setMsg(null); start(async () => {
          const r = await sendDcRequestAction(order.id)
          setMsg(r.ok ? { ok: true, text: 'sent' } : { ok: false, text: r.error ?? 'failed' })
        }) }}
        className="text-xs text-blue-600 hover:text-blue-800 underline disabled:opacity-50 disabled:cursor-progress text-left"
      >
        {pending ? 'sending…' : (order.details_requested_at ? 'Resend' : 'Request details')}
      </button>
      {msg && <span className={`text-[10px] ${msg.ok ? 'text-green-700' : 'text-red-600'}`}>{msg.text}</span>}
    </span>
  )
}

function AttachmentsCell({ order }: { order: StsOrder }) {
  const [pending, start] = useTransition()
  const [err, setErr] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div className="flex flex-col gap-1 min-w-[160px]">
      {order.attachments.length === 0 && <span className="text-xs text-gray-400">none</span>}
      {order.attachments.map(a => (
        <span key={a.id} className="inline-flex items-center gap-1 text-xs">
          {a.url ? (
            <a href={a.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 underline max-w-[140px] truncate" title={a.filename}>{a.filename}</a>
          ) : (
            <span className="text-gray-500 max-w-[140px] truncate">{a.filename}</span>
          )}
          {a.source === 'dc_reply' && <span className="text-[9px] uppercase tracking-wide text-green-600 bg-green-50 rounded px-1">DC</span>}
        </span>
      ))}
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,image/*"
        className="hidden"
        onChange={e => {
          const file = e.target.files?.[0]
          if (!file) return
          setErr(null)
          const fd = new FormData(); fd.set('file', file)
          start(async () => { const r = await uploadStsAttachmentAction(order.id, fd); if (!r.ok) setErr(r.error ?? 'upload failed') })
          if (inputRef.current) inputRef.current.value = ''
        }}
      />
      <button
        type="button"
        disabled={pending}
        onClick={() => inputRef.current?.click()}
        className="text-xs text-gray-500 hover:text-gray-800 underline disabled:opacity-50 text-left"
      >
        {pending ? 'uploading…' : '+ Upload'}
      </button>
      {err && <span className="text-[10px] text-red-600 whitespace-normal">{err}</span>}
    </div>
  )
}

function ReplyText({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="text-xs">
      <button type="button" onClick={() => setOpen(o => !o)} className="text-blue-600 hover:text-blue-800 underline">
        {open ? 'Hide reply' : 'View reply'}
      </button>
      {open && <pre className="mt-1 max-w-[280px] whitespace-pre-wrap text-gray-700 bg-gray-50 rounded p-2 text-[11px]">{text}</pre>}
    </div>
  )
}

export default function ClopayStsTable({ orders }: { orders: StsOrder[] }) {
  const params = useSearchParams()
  const highlightId = params.get('order')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return orders.filter(o => {
      if (status && o.status !== status) return false
      if (q) {
        const hay = [o.external_id, o.customer_po, o.status].filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [orders, search, status])

  const selectCls = 'text-gray-900 border border-gray-300 rounded-md px-2 py-1 text-sm bg-white'

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search order #, PO…"
          className="text-gray-900 border border-gray-300 rounded-md px-3 py-1.5 text-sm w-64 max-w-full"
        />
        <select value={status} onChange={e => setStatus(e.target.value)} className={selectCls}>
          <option value="">All statuses</option>
          {CLOPAY_STS_STAGES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        {(search || status) && (
          <button onClick={() => { setSearch(''); setStatus('') }} className="text-sm text-gray-500 hover:text-gray-800 underline">Clear</button>
        )}
        <span className="text-sm text-gray-500 ml-auto">{rows.length} of {orders.length}</span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="px-3 py-2 text-left font-medium whitespace-nowrap">Order #</th>
              <th className="px-3 py-2 text-left font-medium whitespace-nowrap">PO</th>
              <th className="px-3 py-2 text-left font-medium whitespace-nowrap">Status</th>
              <th className="px-3 py-2 text-left font-medium whitespace-nowrap">DC requested</th>
              <th className="px-3 py-2 text-left font-medium whitespace-nowrap">DC replied</th>
              <th className="px-3 py-2 text-left font-medium whitespace-nowrap">Attachments</th>
              <th className="px-3 py-2 text-left font-medium whitespace-nowrap">Received</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white text-gray-900">
            {rows.map(o => (
              <tr key={o.id} className={`hover:bg-gray-50 ${highlightId === o.id ? 'bg-yellow-50' : ''}`}>
                <td className="px-3 py-2 font-medium whitespace-nowrap">{o.external_id}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600 max-w-[200px] truncate" title={o.customer_po || ''}>{o.customer_po || '—'}</td>
                <td className="px-3 py-2"><StatusSelect orderId={o.id} status={o.status} /></td>
                <td className="px-3 py-2"><DcRequestCell order={o} /></td>
                <td className="px-3 py-2">
                  <div className="flex flex-col gap-0.5">
                    {o.details_received_at
                      ? <span className="text-xs text-green-700">✓ {fmtSeen(o.details_received_at)}</span>
                      : <span className="text-xs text-gray-400">—</span>}
                    {o.dc_reply_text && <ReplyText text={o.dc_reply_text} />}
                  </div>
                </td>
                <td className="px-3 py-2"><AttachmentsCell order={o} /></td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-500 text-xs">{fmtSeen(o.first_seen_at)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-gray-500">No STS orders match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
