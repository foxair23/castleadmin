'use client'

import { Fragment, useMemo, useState, useTransition } from 'react'
import { createSfJobAction, sendNudgeNowAction } from './actions'

// Portal-specific detail captured verbatim by the crawler (Clopay's Summary
// timeline, documents, and notes). Loosely typed — the crawler's exact shape is
// tuned live, so the drawer renders whatever fields are present.
export interface VendorOrderRaw {
  summary?: unknown
  documents?: Array<Record<string, unknown>>
  notes?: Array<Record<string, unknown>>
  [k: string]: unknown
}

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
  raw?: VendorOrderRaw | null
}

// A row has a detail drawer when its raw carries any portal-specific detail
// (Genie's raw is a flat label→value map with none of these, so Genie rows never
// show the expander).
function hasDrawer(o: VendorOrder): boolean {
  const r = o.raw
  if (!r || typeof r !== 'object') return false
  const summary = r.summary
  const hasSummary = Array.isArray(summary) ? summary.length > 0 : (!!summary && typeof summary === 'object' && Object.keys(summary).length > 0)
  // summary_text is captured whenever the detail page was scraped, so it's the
  // reliable "this row has detail" signal even if the milestone parse came up empty.
  const hasSummaryText = typeof (r as { summary_text?: unknown }).summary_text === 'string' && (r as { summary_text: string }).summary_text.length > 0
  return hasSummary || hasSummaryText || (Array.isArray(r.documents) && r.documents.length > 0) || (Array.isArray(r.notes) && r.notes.length > 0)
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

// ── Detail drawer (Clopay: Summary timeline / Documents / Notes) ────────────
const str = (v: unknown): string => v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
// Keys used for the done/date badges — everything else in a milestone object is
// shown as a plain key: value line so nothing captured is hidden.
const DONE_KEYS = ['done', 'completed', 'complete', 'isDone']
const DATE_KEYS = ['date', 'timestamp', 'time', 'when']

function SummaryList({ summary }: { summary: unknown }) {
  if (!summary || typeof summary !== 'object') {
    const s = str(summary)
    return <p className="text-gray-500 text-sm whitespace-pre-wrap">{s || '—'}</p>
  }
  const entries: Array<[string, unknown]> = Array.isArray(summary)
    ? summary.map((m, i) => {
        const o = (m && typeof m === 'object') ? m as Record<string, unknown> : {}
        return [str(o.label ?? o.name ?? o.step ?? `Step ${i + 1}`), m]
      })
    : Object.entries(summary as Record<string, unknown>)
  if (!entries.length) return <p className="text-gray-400 text-sm">—</p>
  return (
    <ul className="space-y-1.5">
      {entries.map(([label, val], i) => {
        const obj = (val && typeof val === 'object' && !Array.isArray(val)) ? val as Record<string, unknown> : null
        const doneKey = obj && DONE_KEYS.find(k => k in obj)
        const done = doneKey ? Boolean(obj![doneKey]) : undefined
        const dateKey = obj && DATE_KEYS.find(k => k in obj)
        const date = dateKey ? str(obj![dateKey]) : undefined
        const rest = obj ? Object.entries(obj).filter(([k]) => k !== doneKey && k !== dateKey && !['label', 'name', 'step'].includes(k)) : []
        const plain = !obj ? str(val) : ''
        return (
          <li key={i} className="text-sm">
            <div className="flex items-center gap-1.5">
              {done !== undefined && <span className={done ? 'text-green-600' : 'text-gray-300'}>{done ? '✓' : '○'}</span>}
              <span className="font-medium text-gray-800">{label}</span>
              {date && <span className="text-gray-500 text-xs">· {date}</span>}
            </div>
            {plain && <div className="text-gray-600 text-xs ml-5 whitespace-pre-wrap">{plain}</div>}
            {rest.map(([k, v]) => (
              <div key={k} className="text-gray-600 text-xs ml-5"><span className="text-gray-400">{k}:</span> {str(v)}</div>
            ))}
          </li>
        )
      })}
    </ul>
  )
}

function DetailDrawer({ order, colSpan }: { order: VendorOrder; colSpan: number }) {
  const r = order.raw ?? {}
  const documents = Array.isArray(r.documents) ? r.documents : []
  const notes = Array.isArray(r.notes) ? r.notes : []
  return (
    <tr className="bg-gray-50">
      <td colSpan={colSpan} className="px-4 py-4">
        <div className="grid gap-6 md:grid-cols-3">
          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Summary</h4>
            {Array.isArray(r.summary) && r.summary.length > 0
              ? <SummaryList summary={r.summary} />
              : (typeof (r as { summary_text?: unknown }).summary_text === 'string' && (r as { summary_text: string }).summary_text
                  ? <p className="text-gray-600 text-sm whitespace-pre-wrap">{(r as { summary_text: string }).summary_text}</p>
                  : <SummaryList summary={r.summary} />)}
          </section>
          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Documents</h4>
            {documents.length ? (
              <ul className="space-y-1.5">
                {documents.map((d, i) => {
                  const href = str(d.href || d.url || d.link)
                  const name = str(d.name || d.filename || d.title) || `Document ${i + 1}`
                  const date = str(d.date || d.timestamp)
                  return (
                    <li key={i} className="text-sm">
                      {href ? (
                        <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 underline">{name}</a>
                      ) : <span className="text-gray-800">{name}</span>}
                      {date && <span className="text-gray-500 text-xs"> · {date}</span>}
                    </li>
                  )
                })}
              </ul>
            ) : <p className="text-gray-400 text-sm">—</p>}
          </section>
          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Notes</h4>
            {notes.length ? (
              <ul className="space-y-2">
                {notes.map((n, i) => {
                  const text = str(n.text || n.note || n.body || n.message)
                  const ts = str(n.timestamp || n.date || n.time)
                  return (
                    <li key={i} className="text-sm">
                      <div className="text-gray-800 whitespace-pre-wrap">{text || '—'}</div>
                      {ts && <div className="text-gray-400 text-xs mt-0.5">{ts}</div>}
                    </li>
                  )
                })}
              </ul>
            ) : <p className="text-gray-400 text-sm">—</p>}
          </section>
        </div>
      </td>
    </tr>
  )
}

export default function VendorOrdersTable({ orders, enableSf = true }: { orders: VendorOrder[]; enableSf?: boolean }) {
  const [sortKey, setSortKey] = useState<SortKey>('first_seen_at')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [nextStep, setNextStep] = useState('')
  const [orderType, setOrderType] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  // Whether any row has a detail drawer — if so we render a leading expander
  // column. Genie rows never do, so its table is visually unchanged.
  const anyDrawer = useMemo(() => orders.some(hasDrawer), [orders])
  const toggleRow = (id: string) => setExpanded(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

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
              {anyDrawer && <th className="px-2 py-2 w-8"></th>}
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
            {rows.map(o => {
              const drawer = hasDrawer(o)
              const isOpen = expanded.has(o.id)
              return (
              <Fragment key={o.id}>
              <tr className="hover:bg-gray-50">
                {anyDrawer && (
                  <td className="px-2 py-2 align-top">
                    {drawer && (
                      <button
                        type="button"
                        onClick={() => toggleRow(o.id)}
                        aria-label={isOpen ? 'Collapse details' : 'Expand details'}
                        className="text-gray-400 hover:text-gray-700 text-xs w-5 h-5 flex items-center justify-center"
                      >
                        {isOpen ? '▼' : '▶'}
                      </button>
                    )}
                  </td>
                )}
                <td className="px-3 py-2 whitespace-nowrap text-gray-700">{fmtSeen(o.first_seen_at)}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">{fmtDate(o.order_date)}</td>
                <td className="px-3 py-2 font-medium whitespace-nowrap">{o.external_id}</td>
                <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full text-xs ${statusStyle(o.status)}`}>{o.status || '—'}</span></td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">{o.customer_po || '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {enableSf ? (
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
                  ) : (
                    <span className="text-gray-600">{o.sf_job_number || '—'}</span>
                  )}
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
              {drawer && isOpen && <DetailDrawer order={o} colSpan={COLUMNS.length + (anyDrawer ? 1 : 0)} />}
              </Fragment>
              )
            })}
            {rows.length === 0 && (
              <tr><td colSpan={COLUMNS.length + (anyDrawer ? 1 : 0)} className="px-3 py-8 text-center text-gray-500">No orders match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
