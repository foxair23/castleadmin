// Server-side helpers for customer job approvals: line-item normalization,
// fingerprinting, token generation, and rendering the itemized quote + legal
// text to HTML. Single source of truth shared by the send action, the public
// approval page, the accept route, and the emails. Mirrors the commission
// acceptance helper (lib/commission/acceptance.ts).

import { createHash, randomBytes } from 'crypto'
import { LEGAL_VERSION, LEGAL_SECTIONS, LEGAL_TITLE } from './legal'

// One line of the approved quote. Kept minimal and stable — this exact shape is
// snapshotted into job_approvals.line_items_snapshot and fingerprinted, so the
// approved record can never drift from what the customer saw.
export interface ApprovalLineItem {
  name: string | null
  description: string | null
  quantity: number | null
  unit_price: number | null
  total: number | null
}

export function fmtCurrency(n: number | null | undefined): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n ?? 0)
}

function fmtQty(n: number | null): string {
  if (n == null) return ''
  return Number.isInteger(n) ? String(n) : String(n)
}

// Normalize raw sf_job_items rows into the stable snapshot shape, filling a line
// total when SF didn't provide one (qty × unit_price).
export function toLineItems(
  rows: Array<{ name?: unknown; description?: unknown; quantity?: unknown; unit_price?: unknown; total?: unknown }>,
): ApprovalLineItem[] {
  const num = (v: unknown): number | null => {
    if (v == null || v === '') return null
    const n = Number(v)
    return Number.isNaN(n) ? null : n
  }
  const str = (v: unknown): string | null => (v != null && v !== '' ? String(v) : null)
  return rows.map(r => {
    const quantity = num(r.quantity)
    const unit_price = num(r.unit_price)
    const total = num(r.total) ?? (quantity != null && unit_price != null ? quantity * unit_price : unit_price)
    return { name: str(r.name), description: str(r.description), quantity, unit_price, total }
  })
}

export function itemsTotal(items: ApprovalLineItem[]): number {
  return items.reduce((sum, it) => sum + (it.total ?? 0), 0)
}

// Fingerprint over the immutable snapshot + legal version. Used to detect drift
// and as a dispute-defensible digest of exactly what was approved.
export function approvalFingerprint(items: ApprovalLineItem[], amountTotal: number, legalVersion: string = LEGAL_VERSION): string {
  const basis = JSON.stringify({ items, amountTotal, legalVersion })
  return createHash('sha256').update(basis).digest('hex').slice(0, 32)
}

// URL-safe unguessable token for the /approve/<token> link (~144 bits).
export function generateApprovalToken(): string {
  return randomBytes(18).toString('base64url')
}

export function buildTokens(input: {
  customerName?: string | null
  jobNumber?: string | null
  amountTotal: number
  approvedName?: string
  approvedAt?: string
}): Record<string, string> {
  return {
    CUSTOMER_NAME: input.customerName ?? '',
    JOB_NUMBER: input.jobNumber ?? '',
    AMOUNT_TOTAL: fmtCurrency(input.amountTotal),
    APPROVED_NAME: input.approvedName ?? '',
    APPROVED_AT: input.approvedAt ?? '',
    LEGAL_VERSION,
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function substitute(text: string, tokens: Record<string, string>): string {
  return esc(text).replace(/\{\{(\w+)\}\}/g, (_, k) => esc(tokens[k] ?? ''))
}

// Full legal text with tokens substituted, as an HTML fragment.
export function renderLegalHtml(tokens: Record<string, string>): string {
  const title = `<h2 style="font-size:17px;font-weight:700;margin:0 0 12px;color:#111827;">${esc(LEGAL_TITLE)}</h2>`
  return title + LEGAL_SECTIONS.map(s =>
    `<h3 style="font-size:15px;font-weight:700;margin:16px 0 6px;color:#111827;">${esc(s.heading)}</h3>` +
    `<p style="font-size:13px;line-height:1.6;color:#374151;margin:0 0 8px;white-space:pre-wrap;">${substitute(s.body, tokens)}</p>`,
  ).join('')
}

// The SF job description as a labeled block. Returns '' when there's no
// description so callers can concatenate unconditionally. Shared by the email
// and the approval page so the wording/markup stays consistent.
export function renderDescriptionHtml(description: string | null | undefined): string {
  const text = (description ?? '').trim()
  if (!text) return ''
  return (
    `<p style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.03em;margin:0 0 6px;">Work Description</p>` +
    `<p style="font-size:14px;line-height:1.6;color:#374151;margin:0 0 4px;white-space:pre-wrap;">${esc(text)}</p>`
  )
}

// Itemized quote table (products & services, qty, unit price, line total) + a
// bold grand total row. Used on both the approval page and the email.
export function renderItemsTableHtml(items: ApprovalLineItem[], total: number): string {
  const th = (t: string, align = 'left') =>
    `<th style="text-align:${align};padding:6px 10px;font-size:12px;font-weight:700;color:#6b7280;border-bottom:1px solid #e5e7eb;text-transform:uppercase;letter-spacing:0.03em;">${esc(t)}</th>`
  const td = (t: string, align = 'left', bold = false) =>
    `<td style="text-align:${align};padding:8px 10px;font-size:13px;color:#111827;${bold ? 'font-weight:600;' : ''}border-bottom:1px solid #f3f4f6;">${esc(t)}</td>`

  const rows = items.map(it => {
    const label = it.name ?? it.description ?? '—'
    const sub = it.name && it.description ? `<div style="font-size:12px;color:#6b7280;margin-top:2px;">${esc(it.description!)}</div>` : ''
    return `<tr>` +
      `<td style="padding:8px 10px;font-size:13px;color:#111827;border-bottom:1px solid #f3f4f6;">${esc(label)}${sub}</td>` +
      td(fmtQty(it.quantity), 'right') +
      td(it.unit_price != null ? fmtCurrency(it.unit_price) : '', 'right') +
      td(it.total != null ? fmtCurrency(it.total) : '', 'right', true) +
      `</tr>`
  }).join('')

  return (
    `<table style="width:100%;border-collapse:collapse;margin:4px 0;">` +
    `<thead><tr>${th('Product / Service')}${th('Qty', 'right')}${th('Unit', 'right')}${th('Total', 'right')}</tr></thead>` +
    `<tbody>${rows}</tbody>` +
    `<tfoot><tr>` +
    `<td colspan="3" style="text-align:right;padding:10px;font-size:14px;font-weight:700;color:#111827;">Total</td>` +
    `<td style="text-align:right;padding:10px;font-size:16px;font-weight:700;color:#C81E1E;">${esc(fmtCurrency(total))}</td>` +
    `</tr></tfoot>` +
    `</table>`
  )
}
