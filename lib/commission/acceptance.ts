// Server-side helpers for commission plan acceptance: fingerprinting, token
// building, and rendering the terms summary + legal text to HTML. Used by the
// tech acceptance screen/route, the accept route, the prompt emailer, and the
// confirmation email so there is a single source of truth.

import { createHash } from 'crypto'
import { LEGAL_VERSION, LEGAL_SECTIONS } from './legal-agreement'

export interface PlanTerms {
  sales_target: number
  rate_below: number
  rate_above: number
  period_start: string // 'YYYY-MM-DD'
  period_end: string   // 'YYYY-MM-DD'
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

export function fmtCurrency(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n ?? 0)
}

// Rates are stored as fractions (0.10 = 10%).
export function fmtPercent(rate: number): string {
  const pct = (rate ?? 0) * 100
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2)}%`
}

function fmtLongDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return `${MONTHS[(m ?? 1) - 1]} ${d}, ${y}`
}

export function fmtPeriodLabel(start: string): string {
  const [y, m] = start.split('-').map(Number)
  return `${MONTHS[(m ?? 1) - 1]} ${y}`
}

// Fingerprint over the variable terms + legal version. A plan is "accepted" iff
// an acceptance row exists with this exact fingerprint.
export function planFingerprint(t: PlanTerms, legalVersion: string = LEGAL_VERSION): string {
  const basis = [t.sales_target, t.rate_below, t.rate_above, t.period_start, t.period_end, legalVersion].join('|')
  return createHash('sha256').update(basis).digest('hex').slice(0, 32)
}

export function buildTokens(
  t: PlanTerms,
  techName: string,
  extra?: { acceptedName?: string; acceptedAt?: string },
): Record<string, string> {
  return {
    TECH_NAME: techName || '',
    PERIOD: fmtPeriodLabel(t.period_start),
    PERIOD_START: fmtLongDate(t.period_start),
    PERIOD_END: fmtLongDate(t.period_end),
    SALES_TARGET: fmtCurrency(t.sales_target),
    RATE_BELOW: fmtPercent(t.rate_below),
    RATE_ABOVE: fmtPercent(t.rate_above),
    ACCEPTED_NAME: extra?.acceptedName ?? '',
    ACCEPTED_AT: extra?.acceptedAt ?? '',
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
  return LEGAL_SECTIONS.map(s =>
    `<h3 style="font-size:15px;font-weight:700;margin:16px 0 6px;color:#111827;">${esc(s.heading)}</h3>` +
    `<p style="font-size:13px;line-height:1.6;color:#374151;margin:0 0 8px;white-space:pre-wrap;">${substitute(s.body, tokens)}</p>`,
  ).join('')
}

// "Your Plan Terms" summary block + plain-English formula line.
export function renderTermsSummaryHtml(t: PlanTerms, tokens: Record<string, string>): string {
  const row = (k: string, v: string) =>
    `<tr><td style="padding:4px 16px 4px 0;color:#6b7280;font-size:13px;">${esc(k)}</td>` +
    `<td style="padding:4px 0;font-weight:600;font-size:13px;color:#111827;">${esc(v)}</td></tr>`
  return (
    `<table style="border-collapse:collapse;margin:4px 0 8px;">` +
    row('Period', tokens.PERIOD) +
    row('Sales target', tokens.SALES_TARGET) +
    row('Rate up to target', tokens.RATE_BELOW) +
    row('Rate above target', tokens.RATE_ABOVE) +
    `</table>` +
    `<p style="font-size:13px;color:#374151;line-height:1.6;margin:6px 0;">` +
    `Commission = ${esc(tokens.RATE_BELOW)} of collected revenue up to ${esc(tokens.SALES_TARGET)}, ` +
    `then ${esc(tokens.RATE_ABOVE)} of collected revenue above ${esc(tokens.SALES_TARGET)}. ` +
    `The target and tiers are measured on revenue actually received during the period.</p>`
  )
}
