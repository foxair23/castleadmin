'use client'

import { Fragment, useEffect, useMemo, useState, useTransition } from 'react'
import { createSfJobAction, sendNudgeNowAction, getOrderDetailAction } from './actions'
import { statusChipStyle } from '@/lib/vendor-orders/status-style'

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
  last_status_change_at: string | null
  schedule_nudge_sent_at: string | null
  raw?: VendorOrderRaw | null
  /** Ingest-computed "this row has drawer detail" flag — `raw` itself is no longer
   *  shipped in the list payload (it's fetched on demand when the drawer opens). */
  has_detail?: boolean | null
  /** Ingest-computed Clopay display dates (migration 103) — folded into order_date /
   *  last_status_change_at server-side; carried on the type for the DB row shape. */
  derived_order_date?: string | null
  derived_last_activity_at?: string | null
  /** TOTAL FEE from the order's current IPO (migration 104), shown in the list. */
  derived_total_fee?: number | null
  total_fee?: number | null
  /** 'portal' = the crawler saw it; 'ipo_document' = recovered from a bundled IPO PDF
   *  because the HD Program portal never lists it (migration 105). */
  record_source?: string | null
  /** Multi-door grouping (migration 106): null on a group's primary. Children are folded
   *  into their primary's row rather than listed separately. */
  parent_order_id?: string | null
  /** How many doors this job covers (1 unless it's a grouped multi-door job). */
  door_count?: number
  attachments?: StoredAttachment[]
}

// One line of the order's current Installer Purchase Order, parsed from the stored PDF.
// Phase 2 maps `item_number` onto the SF services catalog to build SF job line items.
/** One door of a job: its own Clopay order, PO and IPO total, with its line items. */
export interface OrderDoor {
  orderId: string
  external_id: string
  customer_po: string | null
  total_fee: number | null
  record_source: string | null
  items: OrderLineItem[]
}

export interface OrderLineItem {
  line_no: string | null
  quantity: number | null
  item_number: string | null
  description: string | null
  line_fee: number | null
}

// A document file the crawler downloaded to our own storage (signed URL minted
// server-side). `external_ref` is the Clopay documentId, matching raw.documents[].id.
export interface StoredAttachment {
  id: string
  filename: string | null
  mime_type: string | null
  external_ref: string | null
  url: string | null
}

// A row has a detail drawer when its raw carries any portal-specific detail
// (Genie's raw is a flat label→value map with none of these, so Genie rows never
// show the expander).
function hasDrawer(o: VendorOrder): boolean {
  if (o.has_detail != null) return o.has_detail === true // ingest-computed (raw not shipped)
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
const fmtMoney = (n: number | null | undefined) =>
  n == null ? null : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })
const fmtSeen = (s: string) =>
  new Date(s).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

type SortKey =
  | 'external_id' | 'status' | 'next_step' | 'customer_name' | 'street_address'
  | 'phone' | 'email' | 'scope' | 'order_date' | 'schedule_date' | 'customer_po'
  | 'store_number' | 'sf_job_number' | 'first_seen_at' | 'last_seen_at' | 'last_status_change_at'
  | 'total_fee'

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'order_date', label: 'Order Date' },
  { key: 'external_id', label: 'HD Order #' },
  { key: 'status', label: 'Status' },
  { key: 'last_status_change_at', label: 'Last Status Change' },
  { key: 'customer_po', label: 'PO' },
  { key: 'total_fee', label: 'Total Fee' },
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
  { key: 'first_seen_at', label: 'First Seen' },
]

const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b))

function sortVal(o: VendorOrder, k: SortKey): string | number | null {
  return o[k] ?? null
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
// The Clopay detail pages carry a persistent "add a note" composer whose author
// label is the logged-in org + user (e.g. "CASTLE GARAGE INCJohn Fox"). It's not
// real content, so scrub it wherever it lands in the captured text.
const stripComposer = (t: string): string =>
  t.replace(/castle\s*garage[^\n]*/gi, '').replace(/[ \t]{2,}/g, ' ').replace(/\n{2,}/g, '\n').trim()
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

// A job can cover several doors — each its own Clopay order and PO, all bundled in one IPO
// and booked as ONE Service Fusion job. One door renders as a plain line-item table; several
// render per-door with a grand total, which is what the SF job is worth.
function DoorsSection({ doors, groupTotal }: { doors: OrderDoor[]; groupTotal: number | null }) {
  const withItems = doors.filter(d => d.items.length > 0)
  if (withItems.length === 0) return null
  if (withItems.length === 1) return <LineItemsTable items={withItems[0].items} totalFee={withItems[0].total_fee} />

  const sum = withItems.reduce((a, d) => a + (d.total_fee ?? 0), 0)
  return (
    <section className="mb-6">
      <div className="flex items-baseline gap-2 mb-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          {withItems.length} Doors
        </h4>
        <span className="text-[11px] text-gray-400">
          separate Clopay orders on one job — they roll into a single SF job
        </span>
      </div>
      <div className="space-y-4">
        {withItems.map((d, i) => (
          <div key={d.orderId}>
            <div className="flex items-baseline gap-2 mb-1 text-xs">
              <span className="font-semibold text-gray-700">Door {i + 1}</span>
              <span className="text-gray-500">Order {d.external_id}</span>
              {d.customer_po && <span className="text-gray-500">· PO {d.customer_po}</span>}
              {d.record_source === 'ipo_document' && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700" title="Not listed in the HD Program portal — recovered from the IPO document">
                  not in portal
                </span>
              )}
              <span className="ml-auto font-medium text-gray-900 tabular-nums">{fmtMoney(d.total_fee ?? 0)}</span>
            </div>
            <LineItemsTable items={d.items} totalFee={d.total_fee} hideTotal />
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-baseline justify-end gap-3 border-t border-gray-200 pt-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Job Total</span>
        <span className="text-base font-semibold text-gray-900 tabular-nums">{fmtMoney(groupTotal ?? sum)}</span>
      </div>
    </section>
  )
}

// The order's Installer Purchase Order, parsed from the stored PDF: what the work is and
// what Clopay pays us. Full width above the Summary/Documents/Notes grid — it's a real table
// and reads badly squeezed into a narrow column. Product lines are $0.00 (the door, opener,
// molding); the paid lines are the install/delivery/labor ones, so those are emphasized.
function LineItemsTable({ items, totalFee, hideTotal = false }: { items: OrderLineItem[]; totalFee: number | null; hideTotal?: boolean }) {
  const sum = items.reduce((a, i) => a + (i.line_fee ?? 0), 0)
  const mismatch = totalFee != null && Math.abs(sum - totalFee) >= 0.005
  return (
    <section className={hideTotal ? '' : 'mb-6'}>
      <div className={`flex items-baseline gap-2 mb-2 ${hideTotal ? 'hidden' : ''}`}>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Line Items</h4>
        <span className="text-[11px] text-gray-400">from the Installer Purchase Order</span>
        {mismatch && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800" title="Line fees don't add up to the PDF's stated total — check the source document">
            check totals
          </span>
        )}
      </div>
      <div className="overflow-x-auto rounded border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-3 py-1.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide w-16">Line</th>
              <th className="px-3 py-1.5 text-right text-xs font-semibold text-gray-500 uppercase tracking-wide w-14">Qty</th>
              <th className="px-3 py-1.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide w-40">Item #</th>
              <th className="px-3 py-1.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Description</th>
              <th className="px-3 py-1.5 text-right text-xs font-semibold text-gray-500 uppercase tracking-wide w-28">Fee</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {items.map((i, n) => {
              const paid = (i.line_fee ?? 0) > 0
              return (
                <tr key={`${i.line_no ?? n}`} className={paid ? 'bg-green-50/40' : undefined}>
                  <td className="px-3 py-1.5 text-gray-400 whitespace-nowrap">{i.line_no ?? '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">{i.quantity ?? '—'}</td>
                  <td className="px-3 py-1.5 font-mono text-xs text-gray-800 whitespace-nowrap">{i.item_number ?? '—'}</td>
                  <td className={`px-3 py-1.5 ${paid ? 'text-gray-900' : 'text-gray-500'}`}>{i.description || '—'}</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums whitespace-nowrap ${paid ? 'font-medium text-gray-900' : 'text-gray-400'}`}>
                    {fmtMoney(i.line_fee ?? 0)}
                  </td>
                </tr>
              )
            })}
          </tbody>
          {!hideTotal && (
            <tfoot className="border-t border-gray-200 bg-gray-50">
              <tr>
                <td colSpan={4} className="px-3 py-1.5 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">Total Fee</td>
                <td className="px-3 py-1.5 text-right tabular-nums font-semibold text-gray-900 whitespace-nowrap">{fmtMoney(totalFee ?? sum)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </section>
  )
}

function DetailDrawer({ order, colSpan }: { order: VendorOrder; colSpan: number }) {
  // `raw` no longer ships with the list (it dominated the page payload) — fetch it once
  // when the drawer first opens. Rows rendered with an inline raw still work as before.
  const [fetched, setFetched] = useState<VendorOrderRaw | null>(order.raw ?? null)
  const [doors, setDoors] = useState<OrderDoor[]>([])
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (fetched) return
    let alive = true
    getOrderDetailAction(order.id).then(res => {
      if (!alive) return
      if (res.ok) { setFetched((res.raw as VendorOrderRaw) ?? {}); setDoors((res.doors as OrderDoor[]) ?? []) }
      else setFailed(true)
    }).catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once per mount
  }, [])
  if (!fetched) {
    return (
      <tr className="bg-gray-50">
        <td colSpan={colSpan} className="px-4 py-4 text-sm text-gray-400">
          {failed ? 'Could not load details — try again.' : 'Loading details…'}
        </td>
      </tr>
    )
  }
  const r = fetched
  const documents = Array.isArray(r.documents) ? r.documents : []
  // Map Clopay documentId → our stored copy's signed URL, so the drawer links to the
  // file on our server (works even when logged out of Clopay) and falls back to the
  // Clopay link only for docs not yet downloaded.
  const storedByRef = new Map((order.attachments ?? []).filter(a => a.external_ref && a.url).map(a => [a.external_ref as string, a.url as string]))
  // Drop notes that are only the composer label (nothing left after scrubbing).
  const notes = (Array.isArray(r.notes) ? r.notes : []).filter(
    n => stripComposer(str((n as Record<string, unknown>).text || (n as Record<string, unknown>).note || (n as Record<string, unknown>).body || (n as Record<string, unknown>).message)),
  )
  return (
    <tr className="bg-gray-50">
      <td colSpan={colSpan} className="px-4 py-4">
        {doors.some(d => d.items.length > 0) && <DoorsSection doors={doors} groupTotal={order.total_fee ?? null} />}
        <div className="grid gap-6 md:grid-cols-3">
          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Summary</h4>
            {Array.isArray(r.summary) && r.summary.length > 0
              ? <SummaryList summary={r.summary} />
              : (() => {
                  const cleaned = stripComposer(str((r as { summary_text?: unknown }).summary_text))
                  return cleaned
                    ? <p className="text-gray-600 text-sm whitespace-pre-wrap">{cleaned}</p>
                    : <SummaryList summary={r.summary} />
                })()}
          </section>
          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Documents</h4>
            {documents.length ? (
              <ul className="space-y-1.5">
                {documents.map((d, i) => {
                  const docId = str(d.id || d.documentId)
                  const stored = docId ? storedByRef.get(docId) : undefined
                  const href = stored || str(d.href || d.url || d.link)
                  const name = str(d.name || d.filename || d.title) || `Document ${i + 1}`
                  const date = str(d.date || d.timestamp)
                  return (
                    <li key={i} className="text-sm">
                      {href ? (
                        <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 underline">{name}</a>
                      ) : <span className="text-gray-800">{name}</span>}
                      {date && <span className="text-gray-500 text-xs"> · {date}</span>}
                      {!stored && href && <span className="text-amber-600 text-[10px] ml-1" title="Links to Clopay — not yet saved to our server">· on Clopay</span>}
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
                  const text = stripComposer(str(n.text || n.note || n.body || n.message))
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

export default function VendorOrdersTable({ orders, enableSf = true, enableNudge = true, title, defaultSortKey = 'first_seen_at' }: { orders: VendorOrder[]; enableSf?: boolean; enableNudge?: boolean; title?: string; defaultSortKey?: SortKey }) {
  const [sortKey, setSortKey] = useState<SortKey>(defaultSortKey)
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
    else { setSortKey(k); setSortDir(['order_date', 'schedule_date', 'first_seen_at', 'last_seen_at', 'last_status_change_at'].includes(k) ? 'desc' : 'asc') }
  }

  const selectCls = 'text-gray-900 border border-gray-300 rounded-md px-2 py-1 text-sm bg-white'
  const hasFilters = search || status || nextStep || orderType

  return (
    <div>
      {title && (
        <h2 className="text-lg font-semibold text-gray-900 mb-2">{title} <span className="text-sm font-normal text-gray-500">({orders.length})</span></h2>
      )}
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
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">{fmtDate(o.order_date)}</td>
                <td className="px-3 py-2 font-medium whitespace-nowrap">
                  {o.external_id}
                  {o.record_source === 'ipo_document' && (
                    <span
                      className="ml-1.5 align-middle text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700"
                      title="Recovered from a bundled IPO document — Clopay bills this order but the HD Program portal never lists it, so the crawler cannot see it. Status and detail stay empty."
                    >
                      not in portal
                    </span>
                  )}
                </td>
                <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full text-xs ${statusChipStyle(o.status)}`}>{o.status || '—'}</span></td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">{o.last_status_change_at ? fmtSeen(o.last_status_change_at) : '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                {o.customer_po || '—'}
                {(o.door_count ?? 1) > 1 && (
                  <span
                    className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700"
                    title={`${o.door_count} doors on this job, each its own Clopay order and PO — open the row to see them. Total Fee is the whole job.`}
                  >
                    +{(o.door_count ?? 1) - 1} doors
                  </span>
                )}
              </td>
              <td className="px-3 py-2 whitespace-nowrap text-right tabular-nums">
                {o.total_fee != null
                  ? <span className="font-medium text-gray-900" title="TOTAL FEE from this order's Installer Purchase Order">{fmtMoney(o.total_fee)}</span>
                  : <span className="text-gray-300">—</span>}
              </td>
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
                      {enableNudge && (o.sf_created_job_number || o.sf_job_id) && (o.email || o.phone) && (
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
                <td className="px-3 py-2 whitespace-nowrap text-gray-500 text-xs">{fmtSeen(o.first_seen_at)}</td>
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
