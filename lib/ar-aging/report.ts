// Weekly Accounts Receivable Aging Report. Reuses the Action Items "Unpaid
// Jobs" data (getUnpaidJobs) and splits it into three source-based reports:
//   Clopay    — source "Clopay" or "SF&I (Home Depot)"
//   Genie     — source "Genie"
//   Remainder — everything else
// Each becomes its own email. Only the Remainder email shows the Source column.

import type { UnpaidJob } from '@/lib/analytics/alerts'

export type ArGroupKey = 'clopay' | 'genie' | 'remainder'

export interface AgingBucket { label: string; count: number; amount: number }

export interface ArGroup {
  key: ArGroupKey
  label: string
  subject: string
  items: UnpaidJob[]
  count: number
  totalDue: number
  buckets: AgingBucket[]
  includeSource: boolean
}

const SUBJECT_PREFIX = 'Castle Garage - Accounts Receivable Aging Report'

// Case-insensitive, trimmed source matching so minor capitalization/spacing
// variants in Service Fusion still land in the right bucket.
const norm = (s: string | null) => (s ?? '').trim().toLowerCase()
const CLOPAY_SOURCES = new Set(['clopay', 'sf&i (home depot)'])
const isClopay = (j: UnpaidJob) => CLOPAY_SOURCES.has(norm(j.source))
const isGenie = (j: UnpaidJob) => norm(j.source) === 'genie'

const BUCKET_DEFS: { label: string; test: (d: number) => boolean }[] = [
  { label: '0–30 days', test: d => d <= 30 },
  { label: '31–60 days', test: d => d >= 31 && d <= 60 },
  { label: '61–90 days', test: d => d >= 61 && d <= 90 },
  { label: '90+ days', test: d => d > 90 },
]

function buildGroup(key: ArGroupKey, label: string, items: UnpaidJob[], includeSource: boolean): ArGroup {
  // Most overdue first — standard AR aging order.
  const sorted = [...items].sort((a, b) => b.days_outstanding - a.days_outstanding)
  const buckets: AgingBucket[] = BUCKET_DEFS.map(def => {
    const inBucket = sorted.filter(j => def.test(j.days_outstanding))
    return {
      label: def.label,
      count: inBucket.length,
      amount: inBucket.reduce((s, j) => s + j.due_total, 0),
    }
  })
  return {
    key,
    label,
    subject: `${SUBJECT_PREFIX} - ${label}`,
    items: sorted,
    count: sorted.length,
    totalDue: sorted.reduce((s, j) => s + j.due_total, 0),
    buckets,
    includeSource,
  }
}

/** Split unpaid jobs into the three source-based AR groups. */
export function buildArGroups(items: UnpaidJob[]): ArGroup[] {
  return [
    // Clopay spans two sources (Clopay + SF&I (Home Depot)), so show Source.
    // Genie is a single source, so it's omitted there.
    buildGroup('clopay', 'Clopay', items.filter(isClopay), true),
    buildGroup('genie', 'Genie', items.filter(isGenie), false),
    buildGroup('remainder', 'Remainder', items.filter(j => !isClopay(j) && !isGenie(j)), true),
  ]
}

// ── Rendering ────────────────────────────────────────────────────────────────

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Format a timestamptz/ISO closed_at as "Mon D, YYYY" in Pacific time. */
function fmtClosed(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric',
  })
}

/** Monday's date label (PT) for the report header. */
export function reportDateLabel(): string {
  return new Date().toLocaleDateString('en-US', {
    timeZone: 'America/Los_Angeles', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  })
}

export function renderArEmail(g: ArGroup): { subject: string; html: string; text: string } {
  const dateLabel = reportDateLabel()
  const th = (label: string, align = 'left') =>
    `<th style="text-align:${align};padding:8px 10px;font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;border-bottom:2px solid #e5e7eb;">${label}</th>`
  const td = (content: string, align = 'left', extra = '') =>
    `<td style="text-align:${align};padding:8px 10px;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6;${extra}">${content}</td>`

  // Summary — total due + aging breakdown.
  const bucketCells = g.buckets.map(b =>
    `<div style="flex:1;min-width:120px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px;">
      <p style="font-size:11px;color:#6b7280;margin:0;text-transform:uppercase;letter-spacing:.04em;">${b.label}</p>
      <p style="font-size:16px;font-weight:700;color:#111827;margin:3px 0 0;">${money(b.amount)}</p>
      <p style="font-size:11px;color:#9ca3af;margin:1px 0 0;">${b.count} job${b.count === 1 ? '' : 's'}</p>
    </div>`).join('')

  const rowsHtml = g.items.length === 0
    ? `<tr><td colspan="${g.includeSource ? 6 : 5}" style="padding:16px 10px;text-align:center;color:#9ca3af;font-size:13px;">No outstanding balances.</td></tr>`
    : g.items.map(j => `<tr>
        ${td(esc(j.customer_name ?? '—'), 'left', 'font-weight:600;color:#111827;')}
        ${td(esc(j.po_number ?? '—'))}
        ${td(fmtClosed(j.closed_at), 'left', 'white-space:nowrap;')}
        ${td(String(j.days_outstanding), 'right', j.days_outstanding > 90 ? 'color:#b91c1c;font-weight:600;' : '')}
        ${td(money(j.due_total), 'right', 'font-weight:600;color:#b91c1c;white-space:nowrap;')}
        ${g.includeSource ? td(esc(j.source ?? '—')) : ''}
      </tr>`).join('')

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111827;max-width:760px;margin:0 auto;padding:28px 22px;">
  <p style="font-size:20px;font-weight:700;margin:0 0 2px;">Accounts Receivable Aging — ${esc(g.label)}</p>
  <p style="font-size:13px;color:#6b7280;margin:0 0 16px;">${esc(dateLabel)}</p>

  <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:14px 18px;margin-bottom:14px;">
    <p style="font-size:12px;color:#991b1b;margin:0;text-transform:uppercase;letter-spacing:.04em;font-weight:700;">Total Outstanding</p>
    <p style="font-size:28px;font-weight:800;color:#b91c1c;margin:2px 0 0;">${money(g.totalDue)}</p>
    <p style="font-size:12px;color:#991b1b;margin:2px 0 0;">${g.count} unpaid job${g.count === 1 ? '' : 's'}</p>
  </div>

  <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:20px;">${bucketCells}</div>

  <table style="width:100%;border-collapse:collapse;">
    <thead>
      <tr>
        ${th('Customer')}
        ${th('PO #')}
        ${th('Closed')}
        ${th('Days Late', 'right')}
        ${th('Amount Due', 'right')}
        ${g.includeSource ? th('Source') : ''}
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</div>`.trim()

  // Plain-text version
  const lines: string[] = [
    `Accounts Receivable Aging — ${g.label}`,
    dateLabel,
    '',
    `TOTAL OUTSTANDING: ${money(g.totalDue)} (${g.count} unpaid job${g.count === 1 ? '' : 's'})`,
    g.buckets.map(b => `${b.label}: ${money(b.amount)} (${b.count})`).join('  ·  '),
    '',
  ]
  if (g.items.length === 0) {
    lines.push('No outstanding balances.')
  } else {
    for (const j of g.items) {
      const parts = [
        j.customer_name ?? '—',
        `PO ${j.po_number ?? '—'}`,
        `closed ${fmtClosed(j.closed_at)}`,
        `${j.days_outstanding}d late`,
        money(j.due_total),
      ]
      if (g.includeSource) parts.push(j.source ?? '—')
      lines.push(`- ${parts.join(' · ')}`)
    }
  }

  return { subject: g.subject, html, text: lines.join('\n') }
}
