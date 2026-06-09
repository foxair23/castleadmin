'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type {
  UnpaidJob,
  UnpaidJobsResult,
  UninvoicedJob,
  UninvoicedJobsResult,
  StaleEstimate,
  StaleEstimatesResult,
  FollowUpJob,
  FollowUpJobsResult,
  OverdueCustomer,
  OverdueCustomersResult,
  AwaitingSfJobLead,
  AwaitingSfJobResult,
  AwaitingPushLead,
  AwaitingPushResult,
} from '@/lib/analytics/alerts'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtMoney(n: number | null | undefined): string {
  if (n == null) return '—'
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

function fmtDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function AgingPill({ days }: { days: number }) {
  const cls =
    days <= 7
      ? 'bg-green-100 text-green-700'
      : days <= 30
      ? 'bg-amber-100 text-amber-700'
      : 'bg-red-100 text-red-700'
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {days}d
    </span>
  )
}

function CountBadge({ count }: { count: number }) {
  const cls =
    count === 0
      ? 'bg-gray-100 text-gray-500'
      : count <= 5
      ? 'bg-amber-100 text-amber-700'
      : 'bg-red-100 text-red-700'
  return (
    <span className={`inline-block ml-2 px-2 py-0.5 rounded-full text-xs font-semibold ${cls}`}>
      {count}
    </span>
  )
}

function AllClear() {
  return (
    <p className="py-4 text-sm text-green-600 flex items-center gap-1.5">
      <span className="inline-block w-4 h-4 rounded-full bg-green-500 text-white flex items-center justify-center text-xs font-bold">✓</span>
      All clear
    </p>
  )
}

type SortDir = 'asc' | 'desc'

function useSortable<T>(items: T[], defaultKey: keyof T) {
  const [sortKey, setSortKey] = useState<keyof T>(defaultKey)
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  function handleSort(key: keyof T) {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const sorted = [...items].sort((a, b) => {
    const av = a[sortKey]
    const bv = b[sortKey]
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    if (typeof av === 'number' && typeof bv === 'number') {
      return sortDir === 'asc' ? av - bv : bv - av
    }
    const as = String(av)
    const bs = String(bv)
    return sortDir === 'asc' ? as.localeCompare(bs) : bs.localeCompare(as)
  })

  return { sorted, sortKey, sortDir, handleSort }
}

function SortTh<T>({
  col,
  label,
  sortKey,
  sortDir,
  onSort,
}: {
  col: keyof T
  label: string
  sortKey: keyof T
  sortDir: SortDir
  onSort: (k: keyof T) => void
}) {
  const active = col === sortKey
  return (
    <th
      className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide cursor-pointer select-none hover:text-gray-700 whitespace-nowrap"
      onClick={() => onSort(col)}
    >
      {label}
      {active && (
        <span className="ml-1 text-gray-400">{sortDir === 'asc' ? '↑' : '↓'}</span>
      )}
    </th>
  )
}

// ── Alert 1 — Completed but Unpaid Jobs ──────────────────────────────────────

function UnpaidJobsTable({ items }: { items: UnpaidJob[] }) {
  const { sorted, sortKey, sortDir, handleSort } = useSortable(items, 'days_outstanding')

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-y border-gray-200">
          <tr>
            <SortTh col="customer_name" label="Customer" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="number" label="Job #" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="source" label="Source" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="closed_at" label="Closed" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="days_outstanding" label="Days Outstanding" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="due_total" label="Amount Due" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="payment_status" label="Payment Status" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Techs</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {sorted.map(job => (
            <tr key={job.id} className="hover:bg-gray-50">
              <td className="px-4 py-2 font-medium text-gray-900">{job.customer_name ?? '—'}</td>
              <td className="px-4 py-2 text-gray-600">{job.number ?? '—'}</td>
              <td className="px-4 py-2"><SourceBadge source={job.source} /></td>
              <td className="px-4 py-2 text-gray-600 whitespace-nowrap">{fmtDate(job.closed_at)}</td>
              <td className="px-4 py-2"><AgingPill days={job.days_outstanding} /></td>
              <td className="px-4 py-2 font-medium text-red-700">{fmtMoney(job.due_total)}</td>
              <td className="px-4 py-2 text-gray-600">{job.payment_status ?? '—'}</td>
              <td className="px-4 py-2 text-gray-600">{job.tech_names.join(', ') || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Alert 2 — Completed but Never Invoiced ────────────────────────────────────

function UninvoicedJobsTable({ items }: { items: UninvoicedJob[] }) {
  const { sorted, sortKey, sortDir, handleSort } = useSortable(items, 'days_since_completion')

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-y border-gray-200">
          <tr>
            <SortTh col="customer_name" label="Customer" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="number" label="Job #" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="source" label="Source" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="closed_at" label="Closed" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="days_since_completion" label="Days Since Completion" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="total" label="Job Total" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Techs</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {sorted.map(job => (
            <tr key={job.id} className="hover:bg-gray-50">
              <td className="px-4 py-2 font-medium text-gray-900">{job.customer_name ?? '—'}</td>
              <td className="px-4 py-2 text-gray-600">{job.number ?? '—'}</td>
              <td className="px-4 py-2"><SourceBadge source={job.source} /></td>
              <td className="px-4 py-2 text-gray-600 whitespace-nowrap">{fmtDate(job.closed_at)}</td>
              <td className="px-4 py-2"><AgingPill days={job.days_since_completion} /></td>
              <td className="px-4 py-2 text-gray-700">{fmtMoney(job.total)}</td>
              <td className="px-4 py-2 text-gray-600">{job.tech_names.join(', ') || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Alert 3 — Stale Estimates ─────────────────────────────────────────────────

function StaleEstimatesTable({ items }: { items: StaleEstimate[] }) {
  const { sorted, sortKey, sortDir, handleSort } = useSortable(items, 'days_outstanding')

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-y border-gray-200">
          <tr>
            <SortTh col="customer_name" label="Customer" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="number" label="Estimate #" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="created_at_sf" label="Created" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="days_outstanding" label="Days Outstanding" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="total" label="Total" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="status" label="Status" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {sorted.map(est => (
            <tr key={est.id} className="hover:bg-gray-50">
              <td className="px-4 py-2 font-medium text-gray-900">{est.customer_name ?? '—'}</td>
              <td className="px-4 py-2 text-gray-600">{est.number ?? '—'}</td>
              <td className="px-4 py-2 text-gray-600 whitespace-nowrap">{fmtDate(est.created_at_sf)}</td>
              <td className="px-4 py-2"><AgingPill days={est.days_outstanding} /></td>
              <td className="px-4 py-2 text-gray-700">{fmtMoney(est.total)}</td>
              <td className="px-4 py-2 text-gray-600">{est.status ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Alert 4 — Jobs Flagged for Follow-Up ─────────────────────────────────────

function FollowUpJobsTable({ items }: { items: FollowUpJob[] }) {
  const { sorted, sortKey, sortDir, handleSort } = useSortable(items, 'days_open')

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-y border-gray-200">
          <tr>
            <SortTh col="customer_name" label="Customer" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="number" label="Job #" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="source" label="Source" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="start_date" label="Start Date" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="days_open" label="Days Open" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="status" label="Status" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Techs</th>
            <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Note</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {sorted.map(job => (
            <tr key={job.id} className="hover:bg-gray-50">
              <td className="px-4 py-2 font-medium text-gray-900">{job.customer_name ?? '—'}</td>
              <td className="px-4 py-2 text-gray-600">{job.number ?? '—'}</td>
              <td className="px-4 py-2"><SourceBadge source={job.source} /></td>
              <td className="px-4 py-2 text-gray-600 whitespace-nowrap">{fmtDate(job.start_date)}</td>
              <td className="px-4 py-2"><AgingPill days={job.days_open} /></td>
              <td className="px-4 py-2 text-gray-600">{job.status ?? '—'}</td>
              <td className="px-4 py-2 text-gray-600">{job.tech_names.join(', ') || '—'}</td>
              <td className="px-4 py-2 text-gray-600 max-w-xs truncate">
                {job.note_to_customer || job.tech_notes || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Alert 5 — Customers Overdue Past Payment Terms ────────────────────────────

function OverdueCustomersTable({ items }: { items: OverdueCustomer[] }) {
  const { sorted, sortKey, sortDir, handleSort } = useSortable(items, 'days_overdue')

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-y border-gray-200">
          <tr>
            <SortTh col="customer_name" label="Customer" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="account_balance" label="Balance" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="payment_terms" label="Payment Terms" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="oldest_overdue_date" label="Oldest Overdue" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="days_overdue" label="Days Overdue" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="overdue_invoice_count" label="Invoices" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {sorted.map(cust => (
            <tr key={cust.id} className="hover:bg-gray-50">
              <td className="px-4 py-2 font-medium text-gray-900">{cust.customer_name ?? '—'}</td>
              <td className="px-4 py-2 font-medium text-red-700">{fmtMoney(cust.account_balance)}</td>
              <td className="px-4 py-2 text-gray-600">{cust.payment_terms ?? '—'}</td>
              <td className="px-4 py-2 text-gray-600 whitespace-nowrap">{fmtDate(cust.oldest_overdue_date)}</td>
              <td className="px-4 py-2"><AgingPill days={cust.days_overdue} /></td>
              <td className="px-4 py-2 text-gray-600">{cust.overdue_invoice_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Section wrapper ───────────────────────────────────────────────────────────

// ── Alert 6 — Closed Won Awaiting SF Job ─────────────────────────────────────

function AwaitingSfJobTable({ items }: { items: AwaitingSfJobLead[] }) {
  const { sorted, sortKey, sortDir, handleSort } = useSortable(items, 'days_waiting')

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-y border-gray-200">
          <tr>
            <SortTh col="customer_name" label="Customer" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="account_number" label="Account #" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="tag_name" label="Tag" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="assigned_rep_name" label="Rep" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="closed_at" label="Won" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="days_waiting" label="Days waiting" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {sorted.map(l => (
            <tr key={l.id} className="hover:bg-gray-50">
              <td className="px-4 py-2 font-medium text-gray-900">{l.customer_name ?? '—'}</td>
              <td className="px-4 py-2 font-mono text-xs text-gray-600">{l.account_number ?? '—'}</td>
              <td className="px-4 py-2 text-gray-600">
                {l.tag_name
                  ? <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700">{l.tag_name}</span>
                  : <span className="text-gray-400">—</span>
                }
              </td>
              <td className="px-4 py-2 text-gray-600">{l.assigned_rep_name ?? <span className="text-gray-400">Unassigned</span>}</td>
              <td className="px-4 py-2 text-gray-600 whitespace-nowrap">{fmtDate(l.closed_at)}</td>
              <td className="px-4 py-2"><AgingPill days={l.days_waiting} /></td>
              <td className="px-4 py-2 text-right">
                <Link
                  href={`/sales/${l.id}`}
                  className="text-xs text-red-600 hover:text-red-800 font-medium whitespace-nowrap"
                >
                  View lead →
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Alert 7 — Scheduler Leads Awaiting Manual SF Push ────────────────────────

const SERVICE_CATEGORY_LABELS: Record<string, string> = {
  repairs_service: 'Repairs & Service',
  door_panel_replacement: 'Door / Panel Replacement',
  opener_service: 'Opener Service / Replacement',
  gate_opener_service: 'Gate Opener Service / Replacement',
  new_gate_replacement: 'New Gate / Gate Replacement',
  annual_maintenance: 'Annual Maintenance',
}

function AwaitingPushTable({ items }: { items: AwaitingPushLead[] }) {
  const { sorted, sortKey, sortDir, handleSort } = useSortable(items, 'days_waiting')

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-y border-gray-200">
          <tr>
            <SortTh col="customer_name" label="Customer" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="service_type" label="Service" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="appointment_date" label="Appt Date" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="sync_status" label="Status" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="days_waiting" label="Days Waiting" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {sorted.map(lead => (
            <tr key={lead.id} className="hover:bg-gray-50">
              <td className="px-4 py-2 font-medium text-gray-900">{lead.customer_name}</td>
              <td className="px-4 py-2 text-gray-600">
                {lead.service_type === 'gate' ? 'Gate' : 'Garage Door'}
                {' — '}
                {SERVICE_CATEGORY_LABELS[lead.service_category] ?? lead.service_category}
              </td>
              <td className="px-4 py-2 text-gray-600 whitespace-nowrap">{fmtDate(lead.appointment_date)}</td>
              <td className="px-4 py-2">
                <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                  lead.sync_status === 'sync_failed'
                    ? 'bg-red-100 text-red-700'
                    : 'bg-amber-100 text-amber-700'
                }`}>
                  {lead.sync_status === 'sync_failed' ? 'Sync Failed' : 'Not Pushed'}
                </span>
              </td>
              <td className="px-4 py-2"><AgingPill days={lead.days_waiting} /></td>
              <td className="px-4 py-2 text-right">
                <Link
                  href="/admin/scheduler"
                  className="text-xs text-red-600 hover:text-red-800 font-medium whitespace-nowrap"
                >
                  Push to SF →
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function AlertSection({
  title,
  count,
  summary,
  children,
}: {
  title: string
  count: number
  summary?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between gap-4">
        <h2 className="text-base font-semibold text-gray-900 flex items-center">
          {title}
          <CountBadge count={count} />
        </h2>
        {summary}
      </div>
      <div className="px-5 py-3">{children}</div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  unpaidJobs: UnpaidJobsResult
  uninvoicedJobs: UninvoicedJobsResult
  staleEstimates: StaleEstimatesResult
  followUpJobs: FollowUpJobsResult
  overdueCustomers: OverdueCustomersResult
  awaitingSfJob: AwaitingSfJobResult
  awaitingPushLeads: AwaitingPushResult
}

function SourceBadge({ source }: { source: string | null }) {
  if (!source) return <span className="text-gray-400">—</span>
  return (
    <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700 whitespace-nowrap">
      {source}
    </span>
  )
}

function SourceFilterDropdown({
  sources,
  selected,
  onChange,
}: {
  sources: string[]
  selected: string[]
  onChange: (s: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [])

  function toggle(source: string) {
    onChange(selected.includes(source) ? selected.filter(s => s !== source) : [...selected, source])
  }

  const label =
    selected.length === 0 ? 'All sources' :
    selected.length === 1 ? selected[0] :
    `${selected.length} sources`

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="inline-flex items-center gap-2 px-3 py-2 text-sm border border-gray-300 rounded-md bg-white text-gray-700 hover:bg-gray-50 shadow-sm"
      >
        <svg className="h-4 w-4 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z" />
        </svg>
        <span>{label}</span>
        {selected.length > 0 && (
          <span className="inline-flex items-center justify-center h-4 w-4 text-xs font-bold bg-red-600 text-white rounded-full">
            {selected.length}
          </span>
        )}
        <svg className={`h-4 w-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg z-10 py-1">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Filter by source</span>
            {selected.length > 0 && (
              <button onClick={() => onChange([])} className="text-xs text-red-600 hover:text-red-800 font-medium">
                Clear
              </button>
            )}
          </div>
          <div className="max-h-64 overflow-y-auto">
            {sources.map(source => (
              <label key={source} className="flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selected.includes(source)}
                  onChange={() => toggle(source)}
                  className="h-4 w-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
                />
                <span className="text-sm text-gray-700">{source}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const RECONCILE_STEPS = [
  { label: 'jobs (last 120 days)', entities: ['jobs'] },
  { label: 'estimates (last 120 days)', entities: ['estimates'] },
]

function Spinner() {
  return (
    <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  )
}

export default function ActionItemsClient({
  unpaidJobs,
  uninvoicedJobs,
  staleEstimates,
  followUpJobs,
  overdueCustomers,
  awaitingSfJob,
  awaitingPushLeads,
}: Props) {
  const router = useRouter()
  const [syncing, setSyncing] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [sourcesFilter, setSourcesFilter] = useState<string[]>([])

  // Collect unique sources from all job-based sections
  const allSources = Array.from(new Set([
    ...unpaidJobs.items.map(j => j.source),
    ...uninvoicedJobs.items.map(j => j.source),
    ...followUpJobs.items.map(j => j.source),
  ].filter((s): s is string => !!s))).sort()

  const filterBySource = <T extends { source: string | null }>(items: T[]): T[] =>
    sourcesFilter.length === 0 ? items : items.filter(j => j.source !== null && sourcesFilter.includes(j.source))

  const filteredUnpaid = filterBySource(unpaidJobs.items)
  const filteredUninvoiced = filterBySource(uninvoicedJobs.items)
  const filteredFollowUp = filterBySource(followUpJobs.items)

  const totalCount =
    unpaidJobs.items.length +
    uninvoicedJobs.items.length +
    staleEstimates.items.length +
    followUpJobs.items.length +
    overdueCustomers.items.length +
    awaitingSfJob.items.length +
    awaitingPushLeads.items.length

  async function handleRefresh() {
    setSyncing(true)
    setSyncResult(null)
    setProgress(null)

    for (let i = 0; i < RECONCILE_STEPS.length; i++) {
      const step = RECONCILE_STEPS[i]
      const MAX_RETRIES = 5
      let attempt = 0
      let succeeded = false

      while (!succeeded) {
        if (attempt >= MAX_RETRIES) {
          setSyncResult({ ok: false, message: `${step.label} failed after ${MAX_RETRIES} attempts.` })
          setSyncing(false)
          setProgress(null)
          router.refresh()
          return
        }

        setProgress(
          attempt > 0
            ? `Retrying ${step.label} (attempt ${attempt + 1})…`
            : `Reconciling ${step.label} (${i + 1}/${RECONCILE_STEPS.length})…`
        )

        try {
          const res = await fetch('/api/admin/sf-sync/trigger', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'reconcile-scoped', days: 120, entities: step.entities }),
          })
          const text = await res.text()

          if (res.status === 504 || text.includes('FUNCTION_INVOCATION_TIMEOUT')) {
            attempt++
            continue
          }
          if (!res.ok) {
            setSyncResult({ ok: false, message: `Error on ${step.label}: ${text.slice(0, 150)}` })
            setSyncing(false)
            setProgress(null)
            router.refresh()
            return
          }
          succeeded = true
        } catch {
          attempt++
        }
      }
    }

    setSyncResult({ ok: true, message: 'Done.' })
    setSyncing(false)
    setProgress(null)
    router.refresh()
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          Action Items
          <CountBadge count={totalCount} />
        </h1>
        <div className="flex items-center gap-3">
          {allSources.length > 0 && (
            <SourceFilterDropdown
              sources={allSources}
              selected={sourcesFilter}
              onChange={setSourcesFilter}
            />
          )}
          {progress && (
            <span className="text-sm text-gray-500">{progress}</span>
          )}
          {!syncing && syncResult && (
            <span className={`text-sm ${syncResult.ok ? 'text-green-700' : 'text-red-600'}`}>
              {syncResult.message}
            </span>
          )}
          <button
            onClick={handleRefresh}
            disabled={syncing}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-white border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors shadow-sm"
          >
            {syncing ? <Spinner /> : (
              <svg className="h-4 w-4 text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            )}
            {syncing ? 'Syncing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Alert 1 — Completed but Unpaid */}
      <AlertSection
        title="Completed but Unpaid Jobs"
        count={filteredUnpaid.length}
        summary={
          filteredUnpaid.length > 0 ? (
            <span className="text-sm text-gray-600">
              Total due: <span className="font-semibold text-red-700">{fmtMoney(filteredUnpaid.reduce((s, j) => s + j.due_total, 0))}</span>
            </span>
          ) : undefined
        }
      >
        {filteredUnpaid.length === 0 ? (
          <AllClear />
        ) : (
          <UnpaidJobsTable items={filteredUnpaid} />
        )}
      </AlertSection>

      {/* Alert 2 — Never Invoiced */}
      <AlertSection
        title="Completed but Never Invoiced"
        count={filteredUninvoiced.length}
        summary={
          filteredUninvoiced.length > 0 ? (
            <span className="text-sm text-gray-600">
              Uninvoiced total: <span className="font-semibold text-amber-700">{fmtMoney(filteredUninvoiced.reduce((s, j) => s + (j.total ?? 0), 0))}</span>
            </span>
          ) : undefined
        }
      >
        {filteredUninvoiced.length === 0 ? (
          <AllClear />
        ) : (
          <UninvoicedJobsTable items={filteredUninvoiced} />
        )}
      </AlertSection>

      {/* Alert 3 — Stale Estimates */}
      <AlertSection
        title="Stale Estimates (14+ Days)"
        count={staleEstimates.items.length}
        summary={
          staleEstimates.items.length > 0 ? (
            <span className="text-sm text-gray-600">
              Pipeline value: <span className="font-semibold text-amber-700">{fmtMoney(staleEstimates.totalValue)}</span>
            </span>
          ) : undefined
        }
      >
        {staleEstimates.items.length === 0 ? (
          <AllClear />
        ) : (
          <StaleEstimatesTable items={staleEstimates.items} />
        )}
      </AlertSection>

      {/* Alert 4 — Follow-Up Required */}
      <AlertSection
        title="Jobs Flagged for Follow-Up"
        count={filteredFollowUp.length}
      >
        {filteredFollowUp.length === 0 ? (
          <AllClear />
        ) : (
          <FollowUpJobsTable items={filteredFollowUp} />
        )}
      </AlertSection>

      {/* Alert 5 — Overdue Customers */}
      <AlertSection
        title="Customers Overdue Past Payment Terms"
        count={overdueCustomers.items.length}
        summary={
          overdueCustomers.items.length > 0 ? (
            <span className="text-sm text-gray-600">
              Total overdue: <span className="font-semibold text-red-700">{fmtMoney(overdueCustomers.totalOverdue)}</span>
            </span>
          ) : undefined
        }
      >
        {overdueCustomers.items.length === 0 ? (
          <AllClear />
        ) : (
          <OverdueCustomersTable items={overdueCustomers.items} />
        )}
      </AlertSection>

      {/* Alert 6 — Closed Won Awaiting SF Job */}
      <AlertSection
        title="Closed Won — Awaiting SF Job"
        count={awaitingSfJob.items.length}
      >
        {awaitingSfJob.items.length === 0 ? (
          <AllClear />
        ) : (
          <AwaitingSfJobTable items={awaitingSfJob.items} />
        )}
      </AlertSection>

      {/* Alert 7 — Scheduler Leads Awaiting Manual SF Push */}
      <AlertSection
        title="Scheduler Leads — Awaiting SF Push"
        count={awaitingPushLeads.items.length}
      >
        {awaitingPushLeads.items.length === 0 ? (
          <AllClear />
        ) : (
          <AwaitingPushTable items={awaitingPushLeads.items} />
        )}
      </AlertSection>
    </div>
  )
}
