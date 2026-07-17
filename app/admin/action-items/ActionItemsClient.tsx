'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
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
  AwaitingSfJobLead,
  AwaitingSfJobResult,
  OnlineSchedulingLead,
  OnlineSchedulingResult,
  AcceptedEstimateAwaitingJob,
  AcceptedEstimatesResult,
} from '@/lib/analytics/alerts'
import { ACTION_TAB_CONFIG, ACQUISITION_CUTOFF, todayPT, type ActionRecord } from '@/lib/action-items/config'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtMoney(n: number | null | undefined): string {
  if (n == null) return '—'
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function fmtDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—'
  // Date-only values (e.g. appointment_date '2026-07-13') must be formatted
  // from their parts: new Date() would parse them as UTC midnight, which shows
  // as the PREVIOUS day in Pacific time (appointments looked a day early).
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr)
  if (m) return `${MONTHS_SHORT[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// Date + time in the business timezone, e.g. "Jul 1, 2026, 2:34 PM".
function fmtDateTime(dateStr: string | null | undefined): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })
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

// ── Notes cell ────────────────────────────────────────────────────────────────

function NotesCell({ entityType, entityId, initialNote }: {
  entityType: string
  entityId: string
  initialNote: string
}) {
  const [note, setNote] = useState(initialNote)
  const [saved, setSaved] = useState(initialNote)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)

  const save = useCallback(async (value: string) => {
    if (value === saved) { setEditing(false); return }
    setSaving(true)
    await fetch('/api/admin/action-item-notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_type: entityType, entity_id: entityId, note: value }),
    })
    setSaved(value)
    setSaving(false)
    setEditing(false)
  }, [entityType, entityId, saved])

  if (editing) {
    return (
      <td className="px-3 py-1.5 align-top" style={{ minWidth: '180px' }}>
        <textarea
          className="w-full text-xs text-gray-900 border border-gray-300 rounded px-2 py-1 resize-none focus:outline-none focus:ring-1 focus:ring-red-500"
          rows={2}
          value={note}
          onChange={e => setNote(e.target.value)}
          onBlur={() => save(note)}
          disabled={saving}
          autoFocus
        />
      </td>
    )
  }

  return (
    <td
      className="px-3 py-2 text-xs text-gray-600 cursor-text max-w-[180px]"
      onClick={() => setEditing(true)}
      title={saved || 'Click to add note'}
    >
      {saved
        ? <span className="line-clamp-2">{saved}</span>
        : <span className="text-gray-300 italic">Add note…</span>
      }
    </td>
  )
}

// ── Action button / status chip ──────────────────────────────────────────────
// One action per tab (no dropdown). Pressing records who/when and sets the
// follow-up date from the tab's cadence; the chip shows the waiting/due state.
// Pressing again on a due item restarts the clock (e.g. second payment request).

function ActionCell({ tab, entityId, record, itemDate }: { tab: string; entityId: string; record?: ActionRecord; itemDate?: string | null }) {
  // Optimistic: the chip appears the moment the button is pressed; the POST
  // runs in the background and rolls back on failure. No router.refresh() —
  // re-running every alert query made each click take 2-3s.
  const [localRecord, setLocalRecord] = useState<ActionRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const cfg = ACTION_TAB_CONFIG[tab]
  if (!cfg) return <td className="px-4 py-2" />
  const rec = localRecord ?? record

  // Pre-acquisition items are informational only — don't prompt an action.
  if (itemDate && itemDate.slice(0, 10) < ACQUISITION_CUTOFF && !record) {
    return (
      <td className="px-4 py-2 whitespace-nowrap" title="Pre-acquisition — no action prompted">
        <span className="text-xs text-gray-300">—</span>
      </td>
    )
  }

  async function press() {
    if (busy) return
    setBusy(true)
    const prev = rec ?? null
    const [y, m, d] = todayPT().split('-').map(Number)
    setLocalRecord({
      action_label: cfg.button,
      actioned_at: new Date().toISOString(),
      actioned_by_name: null,
      follow_up_on: new Date(Date.UTC(y, m - 1, d + cfg.days)).toISOString().slice(0, 10),
    })
    try {
      const res = await fetch('/api/admin/action-item-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tab, entity_id: entityId }),
      })
      if (!res.ok) setLocalRecord(prev)
    } catch {
      setLocalRecord(prev)
    }
    setBusy(false)
  }

  if (!rec) {
    return (
      <td className="px-4 py-2 whitespace-nowrap">
        <button
          onClick={press}
          disabled={busy}
          className="text-xs bg-red-600 hover:bg-red-700 text-white font-medium px-3 py-1.5 rounded shadow-sm disabled:opacity-50 whitespace-nowrap"
        >
          {busy ? 'Saving…' : `✎ ${cfg.button}`}
        </button>
      </td>
    )
  }

  const due = rec.follow_up_on <= todayPT()
  return (
    <td className="px-4 py-2 whitespace-nowrap">
      <div className="flex flex-col gap-0.5">
        {due ? (
          <button
            onClick={press}
            disabled={busy}
            title={`Records another "${cfg.button}" and restarts the ${cfg.days}-day clock`}
            className="text-xs bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 rounded disabled:opacity-50 whitespace-nowrap"
          >
            {busy ? 'Saving…' : `🔔 Due — ${cfg.button} again`}
          </button>
        ) : (
          <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 whitespace-nowrap">
            ⏳ Waiting til {fmtDate(rec.follow_up_on + 'T12:00:00')}
          </span>
        )}
        <span className="text-[11px] text-gray-400 whitespace-nowrap">
          {rec.action_label} · {fmtDate(rec.actioned_at)}{rec.actioned_by_name ? ` · ${rec.actioned_by_name}` : ''}
        </span>
      </div>
    </td>
  )
}

// ── Alert 1 — Completed but Unpaid Jobs ──────────────────────────────────────

function UnpaidJobsTable({ items, notes, actions }: { items: UnpaidJob[]; notes: Record<string, string>; actions: Record<string, ActionRecord> }) {
  const { sorted, sortKey, sortDir, handleSort } = useSortable(items, 'days_outstanding')

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-y border-gray-200">
          <tr>
            <th className="px-4 py-2 text-left text-xs font-semibold text-red-600 uppercase tracking-wide whitespace-nowrap">Log Action</th>
            <SortTh col="customer_name" label="Customer" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="number" label="Job #" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="po_number" label="PO #" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide w-36">Notes</th>
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
              <ActionCell tab="unpaid" entityId={job.id} record={actions[`sf_job:${job.id}`]} itemDate={job.closed_at} />
              <td className="px-4 py-2 font-medium text-gray-900">{job.customer_name ?? '—'}</td>
              <td className="px-4 py-2 text-gray-600">{job.number ?? '—'}</td>
              <td className="px-4 py-2 text-gray-600 whitespace-nowrap">{job.po_number ?? '—'}</td>
              <NotesCell entityType="sf_job" entityId={job.id} initialNote={notes[`sf_job:${job.id}`] ?? ''} />
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

function UninvoicedJobsTable({ items, notes, actions }: { items: UninvoicedJob[]; notes: Record<string, string>; actions: Record<string, ActionRecord> }) {
  const { sorted, sortKey, sortDir, handleSort } = useSortable(items, 'days_since_completion')

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-y border-gray-200">
          <tr>
            <th className="px-4 py-2 text-left text-xs font-semibold text-red-600 uppercase tracking-wide whitespace-nowrap">Log Action</th>
            <SortTh col="customer_name" label="Customer" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="number" label="Job #" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide w-36">Notes</th>
            <SortTh col="source" label="Source" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="closed_at" label="Closed" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="days_since_completion" label="Days Since Completion" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="total" label="Job Total" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="due_total" label="Amount Due" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Techs</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {sorted.map(job => (
            <tr key={job.id} className="hover:bg-gray-50">
              <ActionCell tab="uninvoiced" entityId={job.id} record={actions[`sf_job:${job.id}`]} itemDate={job.closed_at} />
              <td className="px-4 py-2 font-medium text-gray-900">{job.customer_name ?? '—'}</td>
              <td className="px-4 py-2 text-gray-600">{job.number ?? '—'}</td>
              <NotesCell entityType="sf_job" entityId={job.id} initialNote={notes[`sf_job:${job.id}`] ?? ''} />
              <td className="px-4 py-2"><SourceBadge source={job.source} /></td>
              <td className="px-4 py-2 text-gray-600 whitespace-nowrap">{fmtDate(job.closed_at)}</td>
              <td className="px-4 py-2"><AgingPill days={job.days_since_completion} /></td>
              <td className="px-4 py-2 text-gray-700">{fmtMoney(job.total)}</td>
              <td className={`px-4 py-2 font-medium ${(job.due_total ?? 0) > 0 ? 'text-red-700' : 'text-gray-400'}`}>{fmtMoney(job.due_total)}</td>
              <td className="px-4 py-2 text-gray-600">{job.tech_names.join(', ') || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Alert 3 — Stale Estimates ─────────────────────────────────────────────────

function StaleEstimatesTable({ items, notes, actions }: { items: StaleEstimate[]; notes: Record<string, string>; actions: Record<string, ActionRecord> }) {
  const { sorted, sortKey, sortDir, handleSort } = useSortable(items, 'days_outstanding')

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-y border-gray-200">
          <tr>
            <th className="px-4 py-2 text-left text-xs font-semibold text-red-600 uppercase tracking-wide whitespace-nowrap">Log Action</th>
            <SortTh col="customer_name" label="Customer" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="number" label="Estimate #" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide w-36">Notes</th>
            <SortTh col="created_at_sf" label="Created" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="days_outstanding" label="Days Outstanding" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="total" label="Total" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="status" label="Status" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {sorted.map(est => (
            <tr key={est.id} className="hover:bg-gray-50">
              <ActionCell tab="estimates" entityId={est.id} record={actions[`sf_estimate:${est.id}`]} itemDate={est.created_at_sf} />
              <td className="px-4 py-2 font-medium text-gray-900">{est.customer_name ?? '—'}</td>
              <td className="px-4 py-2 text-gray-600">{est.number ?? '—'}</td>
              <NotesCell entityType="sf_estimate" entityId={est.id} initialNote={notes[`sf_estimate:${est.id}`] ?? ''} />
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


// ── Alert 9 — Accepted Estimates Awaiting Job ────────────────────────────────

function AcceptedEstimatesTable({ items, notes, actions }: { items: AcceptedEstimateAwaitingJob[]; notes: Record<string, string>; actions: Record<string, ActionRecord> }) {
  const { sorted, sortKey, sortDir, handleSort } = useSortable(items, 'days_since_update')

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-y border-gray-200">
          <tr>
            <th className="px-4 py-2 text-left text-xs font-semibold text-red-600 uppercase tracking-wide whitespace-nowrap">Log Action</th>
            <SortTh col="customer_name" label="Customer" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="number" label="Estimate #" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide w-36">Notes</th>
            <SortTh col="status" label="Status" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="updated_at_sf" label="Last Updated" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="days_since_update" label="Days" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="total" label="Value" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {sorted.map(est => (
            <tr key={est.id} className="hover:bg-gray-50">
              <ActionCell tab="accepted-no-job" entityId={est.id} record={actions[`sf_estimate:${est.id}`]} itemDate={est.created_at_sf} />
              <td className="px-4 py-2 font-medium text-gray-900">{est.customer_name ?? '—'}</td>
              <td className="px-4 py-2 text-gray-600">{est.number ?? '—'}</td>
              <NotesCell entityType="sf_estimate" entityId={est.id} initialNote={notes[`sf_estimate:${est.id}`] ?? ''} />
              <td className="px-4 py-2 text-gray-600 whitespace-nowrap">{est.status ?? '—'}</td>
              <td className="px-4 py-2 text-gray-600 whitespace-nowrap">{fmtDate(est.updated_at_sf)}</td>
              <td className="px-4 py-2"><AgingPill days={est.days_since_update} /></td>
              <td className="px-4 py-2 text-gray-700 font-medium">{fmtMoney(est.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Alert 4 — Jobs Flagged for Follow-Up ─────────────────────────────────────

function FollowUpJobsTable({ items, notes, actions }: { items: FollowUpJob[]; notes: Record<string, string>; actions: Record<string, ActionRecord> }) {
  const { sorted, sortKey, sortDir, handleSort } = useSortable(items, 'days_open')

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-y border-gray-200">
          <tr>
            <th className="px-4 py-2 text-left text-xs font-semibold text-red-600 uppercase tracking-wide whitespace-nowrap">Log Action</th>
            <SortTh col="customer_name" label="Customer" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="number" label="Job #" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide w-36">Notes</th>
            <SortTh col="source" label="Source" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="start_date" label="Start Date" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="days_open" label="Days Open" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="status" label="Status" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Techs</th>
            <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">SF Note</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {sorted.map(job => (
            <tr key={job.id} className="hover:bg-gray-50">
              <ActionCell tab="followup" entityId={job.id} record={actions[`sf_job:${job.id}`]} itemDate={job.start_date} />
              <td className="px-4 py-2 font-medium text-gray-900">{job.customer_name ?? '—'}</td>
              <td className="px-4 py-2 text-gray-600">{job.number ?? '—'}</td>
              <NotesCell entityType="sf_job" entityId={job.id} initialNote={notes[`sf_job:${job.id}`] ?? ''} />
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

// ── Section wrapper ───────────────────────────────────────────────────────────

// ── Alert 6 — Closed Won Awaiting SF Job ─────────────────────────────────────

function AwaitingSfJobTable({ items, notes, actions }: { items: AwaitingSfJobLead[]; notes: Record<string, string>; actions: Record<string, ActionRecord> }) {
  const { sorted, sortKey, sortDir, handleSort } = useSortable(items, 'days_waiting')

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-y border-gray-200">
          <tr>
            <th className="px-4 py-2 text-left text-xs font-semibold text-red-600 uppercase tracking-wide whitespace-nowrap">Log Action</th>
            <SortTh col="customer_name" label="Customer" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="account_number" label="Account #" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide w-36">Notes</th>
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
              <ActionCell tab="awaiting-sf" entityId={l.id} record={actions[`sales_lead:${l.id}`]} itemDate={l.closed_at} />
              <td className="px-4 py-2 font-medium text-gray-900">{l.customer_name ?? '—'}</td>
              <td className="px-4 py-2 font-mono text-xs text-gray-600">{l.account_number ?? '—'}</td>
              <NotesCell entityType="sales_lead" entityId={l.id} initialNote={notes[`sales_lead:${l.id}`] ?? ''} />
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

// "Done" button — acknowledges an Online Scheduling lead (requires login).
function DoneButton({ leadId }: { leadId: string }) {
  // Optimistic: flip to the acknowledged chip immediately; the row clears on
  // the next page load. Rolls back if the request fails.
  const [done, setDone] = useState(false)

  async function handleDone() {
    if (done) return
    setDone(true)
    try {
      const res = await fetch('/api/leads/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadId }),
      })
      if (!res.ok) setDone(false)
    } catch {
      setDone(false)
    }
  }

  if (done) {
    return (
      <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 whitespace-nowrap">
        ✓ Done
      </span>
    )
  }
  return (
    <button
      onClick={handleDone}
      className="inline-flex items-center gap-1 px-3 py-1 rounded-md bg-green-600 hover:bg-green-700 text-white text-xs font-medium whitespace-nowrap"
    >
      ✓ Done
    </button>
  )
}

function OnlineSchedulingTable({ items, notes }: { items: OnlineSchedulingLead[]; notes: Record<string, string> }) {
  const { sorted, sortKey, sortDir, handleSort } = useSortable(items, 'days_waiting')

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-y border-gray-200">
          <tr>
            <th className="px-4 py-2 text-left text-xs font-semibold text-red-600 uppercase tracking-wide whitespace-nowrap">Log Action</th>
            <SortTh col="created_at" label="Submitted" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="customer_name" label="Customer" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide w-36">Notes</th>
            <SortTh col="service_type" label="Service" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="appointment_date" label="Appt Date" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="kind" label="Type" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <SortTh col="days_waiting" label="Age" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {sorted.map(lead => (
            <tr key={lead.id} className="hover:bg-gray-50">
              <td className="px-4 py-2 whitespace-nowrap"><DoneButton leadId={lead.id} /></td>
              <td className="px-4 py-2 text-gray-600 whitespace-nowrap">{fmtDateTime(lead.created_at)}</td>
              <td className="px-4 py-2 font-medium text-gray-900">{lead.customer_name}</td>
              <NotesCell entityType="scheduler_lead" entityId={lead.id} initialNote={notes[`scheduler_lead:${lead.id}`] ?? ''} />
              <td className="px-4 py-2 text-gray-600">
                {lead.service_type == null
                  ? <span className="text-gray-400">—</span>
                  : <>{lead.service_type === 'gate' ? 'Gate' : 'Garage Door'}{lead.service_category ? ` — ${SERVICE_CATEGORY_LABELS[lead.service_category] ?? lead.service_category}` : ''}</>}
              </td>
              <td className="px-4 py-2 text-gray-600 whitespace-nowrap">{fmtDate(lead.appointment_date)}</td>
              <td className="px-4 py-2">
                <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                  lead.kind === 'synced'
                    ? 'bg-green-100 text-green-700'
                    : 'bg-amber-100 text-amber-700'
                }`}>
                  {lead.kind === 'synced' ? `Synced${lead.sf_job_id ? ` · Job #${lead.sf_job_id}` : ''}` : 'Partial'}
                </span>
              </td>
              <td className="px-4 py-2"><AgingPill days={lead.days_waiting} /></td>
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
  awaitingSfJob: AwaitingSfJobResult
  onlineScheduling: OnlineSchedulingResult
  actions: Record<string, ActionRecord>
  acceptedEstimates: AcceptedEstimatesResult
  notes: Record<string, string>
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
    selected.length === 1 ? (selected[0] === '__blank__' ? 'No source' : selected[0]) :
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
                {source === '__blank__'
                  ? <span className="text-sm text-gray-400 italic">No source</span>
                  : <span className="text-sm text-gray-700">{source}</span>
                }
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// Each step posts its own trigger body. Invoices sync newest-first, so the
// 180s cap still covers all recent invoices (full exactness comes from the
// Sunday reconcile).
const RECONCILE_STEPS: { label: string; body: Record<string, unknown> }[] = [
  { label: 'jobs (last 120 days)', body: { action: 'reconcile-scoped', days: 120, entities: ['jobs'] } },
  { label: 'estimates', body: { action: 'reconcile-scoped', days: 120, entities: ['estimates'] } },
  { label: 'invoices (newest first)', body: { action: 'sync-entity', entity: 'invoices', maxSeconds: 180 } },
]

function Spinner() {
  return (
    <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  )
}

type TabKey = 'unpaid' | 'uninvoiced' | 'estimates' | 'accepted-no-job' | 'followup' | 'awaiting-sf' | 'online-scheduling'

// Acquisition cutoff. When the "exclude before" filter is on, rows whose event
// date is on or after this day are kept (inclusive of the cutoff day itself).
const CUTOFF_DATE = '2026-04-24'

export default function ActionItemsClient({
  unpaidJobs,
  uninvoicedJobs,
  staleEstimates,
  followUpJobs,
  awaitingSfJob,
  onlineScheduling,
  acceptedEstimates,
  actions,
  notes,
}: Props) {
  const router = useRouter()
  const [syncing, setSyncing] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [sourcesFilter, setSourcesFilter] = useState<string[]>([])
  const [daysFilter, setDaysFilter] = useState<number | null>(null)
  const [daysInput, setDaysInput] = useState('')
  const [activeTab, setActiveTab] = useState<TabKey>('online-scheduling')
  // Deep-link support: the daily digest emails link to ?tab=<key> so a click
  // lands on the relevant tab. Read it once on mount (client-only, so no
  // useSearchParams Suspense boundary needed).
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab')
    const valid: TabKey[] = ['unpaid', 'uninvoiced', 'estimates', 'accepted-no-job', 'followup', 'awaiting-sf', 'online-scheduling']
    if (t && (valid as string[]).includes(t)) setActiveTab(t as TabKey)
  }, [])
  const [excludePreCutoff, setExcludePreCutoff] = useState(false)
  // Never Invoiced: $0 jobs are listed for completeness; this hides them on demand.
  const [hideZeroUninvoiced, setHideZeroUninvoiced] = useState(false)
  // Hide items that were actioned and are still inside their follow-up window.
  const [hideWaiting, setHideWaiting] = useState(false)

  const todayStr = todayPT()
  const isWaiting = (entity: string, id: string) => {
    const a = actions[`${entity}:${id}`]
    return !!a && a.follow_up_on > todayStr
  }
  const notWaiting = <T extends { id: string }>(items: T[], entity: string): T[] =>
    hideWaiting ? items.filter(i => !isWaiting(entity, i.id)) : items

  // '__blank__' is a sentinel for jobs with no source set
  const BLANK = '__blank__'
  const allJobItems = [
    ...unpaidJobs.items,
    ...uninvoicedJobs.items,
    ...followUpJobs.items,
  ]
  const hasBlank = allJobItems.some(j => !j.source)
  const allSources = [
    ...(hasBlank ? [BLANK] : []),
    ...Array.from(new Set(allJobItems.map(j => j.source).filter((s): s is string => !!s))).sort(),
  ]

  const filterBySource = <T extends { source: string | null }>(items: T[]): T[] => {
    if (sourcesFilter.length === 0) return items
    return items.filter(j => {
      if (!j.source) return sourcesFilter.includes(BLANK)
      return sourcesFilter.includes(j.source)
    })
  }

  const filterByDays = <T,>(items: T[], key: keyof T): T[] => {
    if (daysFilter == null) return items
    return items.filter(item => {
      const v = item[key]
      return typeof v === 'number' && v >= daysFilter
    })
  }

  // Optionally exclude items whose event date is before the acquisition cutoff.
  // Inclusive of the cutoff day; rows with no date are kept (can't confirm "before").
  const filterByCutoff = <T,>(items: T[], dateKey: keyof T): T[] => {
    if (!excludePreCutoff) return items
    return items.filter(item => {
      const v = item[dateKey]
      if (v == null) return true
      return String(v).slice(0, 10) >= CUTOFF_DATE
    })
  }

  const filteredUnpaid = notWaiting(filterByCutoff(filterByDays(filterBySource(unpaidJobs.items), 'days_outstanding'), 'closed_at'), 'sf_job')
  const filteredUninvoiced = notWaiting(
    filterByCutoff(filterByDays(filterBySource(uninvoicedJobs.items), 'days_since_completion'), 'closed_at')
      .filter(j => !hideZeroUninvoiced || (j.total ?? 0) > 0),
    'sf_job')
  const filteredFollowUp = notWaiting(filterByCutoff(filterByDays(filterBySource(followUpJobs.items), 'days_open'), 'start_date'), 'sf_job')
  const filteredStaleEstimates = notWaiting(filterByCutoff(filterByDays(staleEstimates.items, 'days_outstanding'), 'created_at_sf'), 'sf_estimate')
  const filteredAwaitingSfJob = notWaiting(filterByCutoff(filterByDays(awaitingSfJob.items, 'days_waiting'), 'closed_at'), 'sales_lead')
  const filteredOnlineScheduling = filterByCutoff(filterByDays(onlineScheduling.items, 'days_waiting'), 'created_at')
  const filteredAcceptedEstimates = notWaiting(filterByCutoff(filterByDays(acceptedEstimates.items, 'days_since_update'), 'created_at_sf'), 'sf_estimate')

  const totalCount =
    filteredUnpaid.length +
    filteredUninvoiced.length +
    filteredStaleEstimates.length +
    filteredFollowUp.length +
    filteredAwaitingSfJob.length +
    filteredOnlineScheduling.length +
    filteredAcceptedEstimates.length

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
            body: JSON.stringify(step.body),
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

  const TABS: { key: TabKey; label: string; count: number }[] = [
    // Ordered by business importance (owner-specified).
    { key: 'online-scheduling', label: 'Online Scheduling', count: filteredOnlineScheduling.length },
    { key: 'unpaid',       label: 'Unpaid Jobs',    count: filteredUnpaid.length },
    { key: 'uninvoiced',   label: 'Never Invoiced', count: filteredUninvoiced.length },
    { key: 'accepted-no-job', label: 'Accepted Estimate - No Job', count: filteredAcceptedEstimates.length },
    { key: 'estimates',    label: 'Stale Estimates',count: filteredStaleEstimates.length },
    { key: 'awaiting-sf',  label: 'Marketing Lead - Awaiting SF Job', count: filteredAwaitingSfJob.length },
    { key: 'followup',     label: 'Follow-Up',      count: filteredFollowUp.length },
  ]

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          Action Items
          <CountBadge count={totalCount} />
        </h1>
        <div className="flex items-center gap-3 flex-wrap">
          {allSources.length > 0 && (
            <SourceFilterDropdown
              sources={allSources}
              selected={sourcesFilter}
              onChange={setSourcesFilter}
            />
          )}
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700 select-none cursor-pointer">
            <input
              type="checkbox"
              checked={excludePreCutoff}
              onChange={e => setExcludePreCutoff(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
            />
            Exclude before Apr 24, 2026
          </label>
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700 select-none cursor-pointer">
            <input
              type="checkbox"
              checked={hideWaiting}
              onChange={e => setHideWaiting(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
            />
            Hide ⏳ waiting
          </label>
          <div className="flex items-center rounded-md border border-gray-300 bg-white shadow-sm overflow-hidden text-sm">
            {([null, 30, 60, 90, 120] as (number | null)[]).map(opt => (
              <button
                key={opt ?? 'all'}
                onClick={() => { setDaysFilter(opt); setDaysInput('') }}
                className={`px-3 py-2 font-medium transition-colors whitespace-nowrap border-r border-gray-300 ${
                  daysFilter === opt && daysInput === ''
                    ? 'bg-red-600 text-white'
                    : 'text-gray-600 hover:bg-gray-50'
                }`}
              >
                {opt == null ? 'All' : `${opt}+`}
              </button>
            ))}
            <div className="flex items-center border-l border-gray-300 px-2 gap-1">
              <input
                type="number"
                min={1}
                placeholder="Custom"
                value={daysInput}
                onChange={e => {
                  const val = e.target.value
                  setDaysInput(val)
                  const n = parseInt(val, 10)
                  setDaysFilter(val === '' ? null : isNaN(n) ? null : n)
                }}
                className="w-20 py-1.5 text-sm text-gray-900 bg-transparent focus:outline-none placeholder:text-gray-400"
              />
              {daysInput && (
                <button
                  onClick={() => { setDaysInput(''); setDaysFilter(null) }}
                  className="text-gray-400 hover:text-gray-600"
                >
                  ×
                </button>
              )}
            </div>
          </div>
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

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-gray-200 overflow-x-auto pb-px">
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors -mb-px ${
              activeTab === tab.key
                ? 'border-red-600 text-red-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            {tab.label}
            <CountBadge count={tab.count} />
          </button>
        ))}
      </div>

      {/* Active tab content */}
      {activeTab === 'unpaid' && (
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
          <p className="text-xs text-gray-400 mb-2">A row clears automatically when the job&rsquo;s balance reaches $0 in Service Fusion.</p>
          {filteredUnpaid.length === 0 ? <AllClear /> : <UnpaidJobsTable items={filteredUnpaid} notes={notes} actions={actions} />}
        </AlertSection>
      )}

      {activeTab === 'uninvoiced' && (
        <AlertSection
          title="Completed but Never Invoiced"
          count={filteredUninvoiced.length}
          summary={
            <span className="flex items-center gap-4">
              <label className="flex items-center gap-1.5 text-sm text-gray-600 whitespace-nowrap cursor-pointer">
                <input
                  type="checkbox"
                  checked={hideZeroUninvoiced}
                  onChange={e => setHideZeroUninvoiced(e.target.checked)}
                  className="h-4 w-4"
                />
                Hide $0 jobs
              </label>
              {filteredUninvoiced.length > 0 && (
                <span className="text-sm text-gray-600 whitespace-nowrap">
                  Uninvoiced total: <span className="font-semibold text-amber-700">{fmtMoney(filteredUninvoiced.reduce((s, j) => s + (j.total ?? 0), 0))}</span>
                </span>
              )}
            </span>
          }
        >
          <p className="text-xs text-gray-400 mb-2">A row clears automatically when an invoice is created on the job in Service Fusion.</p>
          {filteredUninvoiced.length === 0 ? <AllClear /> : <UninvoicedJobsTable items={filteredUninvoiced} notes={notes} actions={actions} />}
        </AlertSection>
      )}

      {activeTab === 'estimates' && (
        <AlertSection
          title="Stale Estimates (14+ Days)"
          count={filteredStaleEstimates.length}
          summary={
            filteredStaleEstimates.length > 0 ? (
              <span className="text-sm text-gray-600">
                Pipeline value: <span className="font-semibold text-amber-700">{fmtMoney(filteredStaleEstimates.reduce((s, e) => s + (e.total ?? 0), 0))}</span>
              </span>
            ) : undefined
          }
        >
          <p className="text-xs text-gray-400 mb-2">A row clears automatically when the estimate moves to Estimate Accepted, Estimate Won, or Lost in Service Fusion.</p>
          {filteredStaleEstimates.length === 0 ? <AllClear /> : <StaleEstimatesTable items={filteredStaleEstimates} notes={notes} actions={actions} />}
        </AlertSection>
      )}

      {activeTab === 'accepted-no-job' && (
        <AlertSection
          title="Accepted Estimate — No Job"
          count={filteredAcceptedEstimates.length}
          summary={
            filteredAcceptedEstimates.length > 0 ? (
              <span className="text-sm text-gray-600">
                Value at risk: <span className="font-semibold text-amber-700">{fmtMoney(filteredAcceptedEstimates.reduce((s, e) => s + (e.total ?? 0), 0))}</span>
              </span>
            ) : undefined
          }
        >
          <p className="text-xs text-gray-400 mb-2">
            Estimates in <span className="font-medium">Estimate Accepted</span> — the customer said yes but the
            estimate hasn&rsquo;t been converted to a job. Converting it in Service Fusion (status moves to
            Estimate Won) — or marking it Lost — clears it from this list automatically.
          </p>
          {filteredAcceptedEstimates.length === 0 ? <AllClear /> : <AcceptedEstimatesTable items={filteredAcceptedEstimates} notes={notes} actions={actions} />}
        </AlertSection>
      )}

      {activeTab === 'followup' && (
        <AlertSection
          title="Jobs Flagged for Follow-Up"
          count={filteredFollowUp.length}
        >
          <p className="text-xs text-gray-400 mb-2">A row clears automatically when the follow-up flag is removed from the job in Service Fusion.</p>
          {filteredFollowUp.length === 0 ? <AllClear /> : <FollowUpJobsTable items={filteredFollowUp} notes={notes} actions={actions} />}
        </AlertSection>
      )}

      {activeTab === 'awaiting-sf' && (
        <AlertSection
          title="Marketing Lead — Awaiting SF Job"
          count={filteredAwaitingSfJob.length}
        >
          <p className="text-xs text-gray-400 mb-2">A row clears automatically when an SF job is recorded for the won lead.</p>
          {filteredAwaitingSfJob.length === 0 ? <AllClear /> : <AwaitingSfJobTable items={filteredAwaitingSfJob} notes={notes} actions={actions} />}
        </AlertSection>
      )}

      {activeTab === 'online-scheduling' && (
        <AlertSection
          title="Online Scheduling — Leads Awaiting Acknowledgement"
          count={filteredOnlineScheduling.length}
        >
          <p className="text-xs text-gray-400 mb-2">A row clears when someone presses Done (in the email or here).</p>
          {filteredOnlineScheduling.length === 0 ? <AllClear /> : <OnlineSchedulingTable items={filteredOnlineScheduling} notes={notes} />}
        </AlertSection>
      )}

    </div>
  )
}
