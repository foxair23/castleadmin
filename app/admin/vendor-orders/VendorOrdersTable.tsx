'use client'

import { useMemo, useState } from 'react'

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
  detail_scraped_at: string | null
  last_seen_at: string
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
  | 'store_number' | 'sf_job_id' | 'last_seen_at'

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'external_id', label: 'Order #' },
  { key: 'status', label: 'Status' },
  { key: 'next_step', label: 'Next Step' },
  { key: 'customer_name', label: 'Customer' },
  { key: 'street_address', label: 'Address' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'scope', label: 'Scope' },
  { key: 'order_date', label: 'Order' },
  { key: 'schedule_date', label: 'Scheduled' },
  { key: 'customer_po', label: 'PO' },
  { key: 'store_number', label: 'Store' },
  { key: 'sf_job_id', label: 'SF Job' },
  { key: 'last_seen_at', label: 'Seen' },
]

const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b))

function sortVal(o: VendorOrder, k: SortKey): string | number | null {
  if (k === 'sf_job_id') return o.sf_job_id ? 1 : 0
  return o[k]
}

export default function VendorOrdersTable({ orders }: { orders: VendorOrder[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('order_date')
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
        const hay = [o.external_id, o.customer_name, o.street_address, o.city, o.customer_po, o.store_number, o.email, o.phone, o.scope, o.next_step, o.status]
          .filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
    return filtered.sort((a, b) => {
      const av = sortVal(a, sortKey), bv = sortVal(b, sortKey)
      const an = av == null || av === ''
      const bn = bv == null || bv === ''
      if (an && bn) return 0
      if (an) return 1  // empties always last
      if (bn) return -1
      let c: number
      if (sortKey === 'external_id') c = (Number(av) - Number(bv)) || String(av).localeCompare(String(bv))
      else if (typeof av === 'number' && typeof bv === 'number') c = av - bv
      else c = String(av).localeCompare(String(bv))
      return sortDir === 'asc' ? c : -c
    })
  }, [orders, search, status, nextStep, orderType, sortKey, sortDir])

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(k); setSortDir(k === 'order_date' || k === 'schedule_date' || k === 'last_seen_at' ? 'desc' : 'asc') }
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
                <td className="px-3 py-2 font-medium whitespace-nowrap">{o.external_id}</td>
                <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full text-xs ${statusStyle(o.status)}`}>{o.status || '—'}</span></td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">{o.next_step || '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap">{o.customer_name || '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">{o.street_address ? `${o.street_address}${o.city ? ', ' + o.city : ''}${o.state_prov ? ', ' + o.state_prov : ''}${o.postal_code ? ' ' + o.postal_code : ''}` : (o.city ? `${o.city}${o.state_prov ? ', ' + o.state_prov : ''}` : '—')}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">{o.phone || '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">{o.email || '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600 max-w-[200px] truncate" title={o.scope || ''}>{o.scope || '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">{fmtDate(o.order_date)}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">{fmtDate(o.schedule_date)}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">{o.customer_po || '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">{o.store_number || '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap">{o.sf_job_id ? <span className="text-green-700">✓</span> : <span className="text-gray-300">—</span>}</td>
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
