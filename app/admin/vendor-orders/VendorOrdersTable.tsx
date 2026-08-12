'use client'

import { useMemo, useState, useTransition } from 'react'
import { createSfJobAction, sendNudgeNowAction } from './actions'

export interface VendorOrder {
  id: string
  external_id: string
  status: string | null
  next_step: string | null
  order_type: string | null
  customer_name: string | null
  customer_po: string | null
  store_number: string | null
  order_date: string | null
  schedule_date: string | null
  street_address: string | null
  city: string | null
  state_prov: string | null
  postal_code: string | null
  phone: string | null
  email: string | null
  scope: string | null
  sf_job_id: string | null
  sf_created_job_number: string | null
  sf_job_number: string | null
  sf_match_method: 'linked' | 'po' | 'name' | 'email' | 'phone' | 'pending' | null
  detail_scraped_at: string | null
  first_seen_at: string
  last_seen_at: string
  schedule_nudge_sent_at: string | null
}

const fmtDate = (s: string | null) =>
  s ? new Date(s + (s.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric' }) : '—'
const fmtSeen = (s: string) =>
  new Date(s).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

const statusStyle = (s: string | null) => {
  const k = (s || '').toLowerCase()
  if (k.startsWith('open')) return 'bg-green-100 text-green-800'
  if (k.startsWith('cancel')) return 'bg-red-100 text-red-700'
  if (k.startsWith('clos') || k.startsWith('complet')) return 'bg-gray-100 text-gray-500'
  return 'bg-amber-100 text-amber-800'
}

type SortKey =
  | 'external_id' | 'status' | 'next_step' | 'customer_name' | 'street_address'
  | 'phone' | 'email' | 'scope' | 'order_date' | 'schedule_date' | 'customer_po'
  | 'store_number' | 'sf_job_number' | 'first_seen_at' | 'last_seen_at'

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'first_seen_at', label: 'First Seen' },
  { key: 'order_date', label: 'Order Date' },
  { key: 'external_id', label: 'HD Order #' },
  { key: 'status', label: 'Status' },
  { key: 'customer_po', label: 'PO' },
  { key: 'sf_job_number', label: 'SF Job #' },
  { key: 'next_step', label: 'Next Step' },
  { key: 'customer_name', label: 'Customer' },
  { key: 'street_address', label: 'Address' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'scope', label: 'Scope' },
  { key: 'schedule_date', label: 'Scheduled' },
  { key: 'store_number', label: 'Store' },
  { key: 'last_seen_at', label: 'Seen' },
]

const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b))

function sortVal(o: VendorOrder, k: SortKey): string | number | null {
  return o[k]
}

function CreateJobButton({ orderId }: { orderId: string }) {
  const [pending, start] = useTransition()
  const [err, setErr] = useState<string | null>(null)
  return (
    <span className="inline-flex flex-col gap-0.5">
      <button
        type="button"
        disabled={pending}
        onClick={() => { setErr(null); start(async () => { const r = await createSfJobAction(orderId); if (!r.ok) setErr(r.error ?? 'failed') }) }}
        className="text-xs text-blue-600 hover:text-blue-800 underline disabled:opacity-50 disabled:cursor-progress"
      >
        {pending ? 'creating…' : '+ Create SF Job'}
      </button>
      {err && <span className="text-[10px] text-red-600 max-w-[180px] whitespace-normal">{err}</span>}
    </span>
  )
}

// Manually send the schedule reminder (email + SMS) for orders that have an SF
// job — e.g. ones that landed before the nudge cutoff, or a customer who lost
// the link. Shows "Resend" once one has already gone out.
function NudgeButton({ orderId, sentAt }: { orderId: string; sentAt: string | null }) {
  const [pending, start] = useTransition()
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  return (
    <span className="inline-flex flex-col gap-0.5">
      <button
        type="button"
        disabled={pending}
        onClick={() => { setMsg(null); start(async () => {
          const r = await sendNudgeNowAction(orderId)
          setMsg(r.ok ? { ok: true, text: `sent ${r.channels?.join(' + ') ?? ''}`.trim() } : { ok: false, text: r.error ?? 'failed' })
        }) }}
        className="text-xs text-blue-600 hover:text-blue-800 underline disabled:opacity-50 disabled:cursor-progress"
      >
        {pending ? 'sending…' : (sentAt ? 'Resend reminder' : 'Send reminder')}
      </button>
      {msg && <span className={`text-[10px] max-w-[180px] whitespace-normal ${msg.ok ? 'text-green-700' : 'text-red-600'}`}>{msg.text}</span>}
    </span>
  )
}

export default function VendorOrdersTable({ orders }: { orders: VendorOrder[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('first_seen_at')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [nextStep, setNextStep] = useState('')
  const [orderType, setOrderType] = useState('')

  const statuses = useMemo(() => uniq(orders.map(o => o.status)), [orders])
  const nextSteps = useMemo(() => uniq(orders.map(o => o.next_step)), [orders])
  const orderTypes = useMemo(() => uniq(orders.map(o => o.order_type)), [orders])

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filtered = orders.filter(o => {
      if (status && o.status !== status) return false
      if (nextStep && o.next_step !== nextStep) return false
      if (orderType && o.order_type !== orderType) return false
      if (q) {
        const hay = [o.external_id, o.customer_name, o.street_address, o.city, o.customer_po, o.store_number, o.email, o.phone, o.scope, o.next_step, o.status, o.sf_job_number]
          .filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
    const cmpBy = (a: VendorOrder, b: VendorOrder, key: SortKey, dir: 'asc' | 'desc'): number => {
      const av = sortVal(a, key), bv = sortVal(b, key)
      const an = av == null || av === ''
      const bn = bv == null || bv === ''
      if (an && bn) return 0
      if (an) return 1  // empties always last
      if (bn) return -1
      let c: number
      if (key === 'external_id') c = (Number(av) - Number(bv)) || String(av).localeCompare(String(bv))
      else if (typeof av === 'number' && typeof bv === 'number') c = av - bv
      else c = String(av).localeCompare(String(bv))
      return dir === 'asc' ? c : -c
    }
    return filtered.sort((a, b) => {
      const primary = cmpBy(a, b, sortKey, sortDir)
      if (primary !== 0) return primary
      // Secondary tiebreak: Order Date, newest first — so within one scrape batch
      // (which shares a first_seen_at) orders sort by their order date.
      return sortKey === 'order_date' ? 0 : cmpBy(a, b, 'order_date', 'desc')
    })
  }, [orders, search, status, nextStep, orderType, sortKey, sortDir])

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(k); setSortDir(['order_date', 'schedule_date', 'first_seen_at', 'last_seen_at'].includes(k) ? 'desc' : 'asc') }
  }

  const selectCls = 'text-gray-900 border border-gray-300 rounded-md px-2 py-1 text-sm bg-white'
  const hasFilters = search || status || nextStep || orderType

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search order #, customer, address, PO, store…"
          className="text-gray-900 border border-gray-300 rounded-md px-3 py-1.5 text-sm w-72 max-w-full"
        />
        <select value={status} onChange={e => setStatus(e.target.value)} className={selectCls}>
          <option value="">All statuses</option>
          {statuses.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={nextStep} onChange={e => setNextStep(e.target.value)} className={selectCls}>
          <option value="">All next steps</option>
          {nextSteps.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={orderType} onChange={e => setOrderType(e.target.value)} className={selectCls}>
          <option value="">All types</option>
          {orderTypes.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        {hasFilters && (
          <button
            onClick={() => { setSearch(''); setStatus(''); setNextStep(''); setOrderType('') }}
            className="text-sm text-gray-500 hover:text-gray-800 underline"
          >
            Clear
          </button>
        )}
        <span className="text-sm text-gray-500 ml-auto">{rows.length} of {orders.length}</span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              {COLUMNS.map(col => (
                <th
                  key={col.key}
                  onClick={() => toggleSort(col.key)}
                  className="px-3 py-2 text-left font-medium whitespace-nowrap cursor-pointer select-none hover:bg-gray-100"
                >
                  {col.label}
                  <span className="text-gray-400">{sortKey === col.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white text-gray-900">
            {rows.map(o => (
              <tr key={o.id} className="hover:bg-gray-50">
                <td className="px-3 py-2 whitespace-nowrap text-gray-700">{fmtSeen(o.first_seen_at)}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">{fmtDate(o.order_date)}</td>
                <td className="px-3 py-2 font-medium whitespace-nowrap">{o.external_id}</td>
                <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full text-xs ${statusStyle(o.status)}`}>{o.status || '—'}</span></td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">{o.customer_po || '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <div className="flex flex-col gap-1">
                    {o.sf_job_number ? (
                      <span className="inline-flex items-center gap-1.5" title={o.sf_match_method === 'pending' ? 'created — awaiting mirror sync' : (o.sf_match_method ? `matched by ${o.sf_match_method}` : undefined)}>
                        <span className={`font-medium ${o.sf_match_method === 'po' || o.sf_match_method === 'linked' ? 'text-green-700' : o.sf_match_method === 'pending' ? 'text-blue-600' : 'text-amber-700'}`}>{o.sf_job_number}</span>
                        {o.sf_match_method === 'pending' && <span className="text-[10px] uppercase tracking-wide text-blue-600 bg-blue-50 rounded px-1">pending sync</span>}
                        {o.sf_match_method && !['po', 'linked', 'pending'].includes(o.sf_match_method) && (
                          <span className="text-[10px] uppercase tracking-wide text-amber-600 bg-amber-50 rounded px-1">{o.sf_match_method}</span>
                        )}
                      </span>
                    ) : <CreateJobButton orderId={o.id} />}
                    {(o.sf_created_job_number || o.sf_job_id) && (o.email || o.phone) && (
                      <NudgeButton orderId={o.id} sentAt={o.schedule_nudge_sent_at} />
                    )}
                  </div>
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">{o.next_step || '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap">{o.customer_name || '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">{o.street_address ? `${o.street_address}${o.city ? ', ' + o.city : ''}${o.state_prov ? ', ' + o.state_prov : ''}${o.postal_code ? ' ' + o.postal_code : ''}` : (o.city ? `${o.city}${o.state_prov ? ', ' + o.state_prov : ''}` : '—')}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">{o.phone || '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">{o.email || '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600 max-w-[200px] truncate" title={o.scope || ''}>{o.scope || '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">{fmtDate(o.schedule_date)}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">{o.store_number || '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-400 text-xs">{fmtSeen(o.last_seen_at)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={COLUMNS.length} className="px-3 py-8 text-center text-gray-500">No orders match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
