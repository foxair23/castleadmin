import type { PlanTerms } from '@/lib/commission/acceptance'
import { buildTokens, renderLegalHtml, renderTermsSummaryHtml, fmtPeriodLabel } from '@/lib/commission/acceptance'

const BASE = `font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #111827; max-width: 640px; margin: 0 auto; padding: 32px 24px;`
const HEADING = `font-size: 20px; font-weight: 700; margin: 0 0 8px;`
const MUTED = `font-size: 12px; color: #9ca3af; margin: 20px 0 0;`

// Confirmation email — the legally-binding record of what the tech accepted.
export function renderCommissionAcceptanceEmail(params: {
  terms: PlanTerms
  techName: string
  acceptedName: string
  acceptedAt: string   // formatted, human-readable, with timezone
  legalVersion: string
  ip?: string | null
}): { subject: string; html: string; text: string } {
  const { terms, techName, acceptedName, acceptedAt, legalVersion, ip } = params
  const tokens = buildTokens(terms, techName, { acceptedName, acceptedAt })
  const period = fmtPeriodLabel(terms.period_start)

  const subject = `Commission Agreement accepted — ${period}`

  const html = `
<div style="${BASE}">
  <p style="${HEADING}">Commission Agreement — Accepted</p>
  <p style="font-size:14px;color:#374151;margin:0 0 4px;">
    Accepted by <strong>${escape(acceptedName)}</strong> on <strong>${escape(acceptedAt)}</strong>.
  </p>
  <p style="font-size:13px;color:#6b7280;margin:0 0 16px;">
    This email is your record of the commission terms you agreed to for ${escape(period)}.
  </p>

  <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;margin-bottom:16px;">
    <p style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;margin:0 0 6px;">Your Plan Terms</p>
    ${renderTermsSummaryHtml(terms, tokens)}
  </div>

  <div style="border-top:1px solid #e5e7eb;padding-top:8px;">
    ${renderLegalHtml(tokens)}
  </div>

  <p style="${MUTED}">
    Agreement version ${escape(legalVersion)} · Accepted ${escape(acceptedAt)}${ip ? ` · IP ${escape(ip)}` : ''}.<br/>
    Castle Garage Inc. If you did not accept this, contact your administrator immediately.
  </p>
</div>`.trim()

  const text = [
    `Commission Agreement — Accepted`,
    ``,
    `Accepted by ${acceptedName} on ${acceptedAt}.`,
    `Period: ${period}`,
    ``,
    `This email is your record of the commission terms you agreed to.`,
    `Agreement version ${legalVersion}${ip ? ` · IP ${ip}` : ''}.`,
  ].join('\n')

  return { subject, html, text }
}

// Prompt email — sent when a new/changed plan needs the tech's acceptance.
export function renderCommissionPromptEmail(params: {
  terms: PlanTerms
  techName: string
  appUrl: string
}): { subject: string; html: string; text: string } {
  const { terms, techName, appUrl } = params
  const tokens = buildTokens(terms, techName)
  const period = fmtPeriodLabel(terms.period_start)
  const link = `${appUrl.replace(/\/$/, '')}/tech/commission`

  const subject = `Action needed: accept your commission plan — ${period}`

  const html = `
<div style="${BASE}">
  <p style="${HEADING}">A commission plan needs your acceptance</p>
  <p style="font-size:14px;color:#374151;margin:0 0 16px;">
    Hi ${escape(techName || 'there')}, your commission plan for <strong>${escape(period)}</strong> is ready.
    Please log in to review the terms and accept the agreement — your commission details for this period
    unlock once you accept.
  </p>

  <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;margin-bottom:16px;">
    <p style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;margin:0 0 6px;">Plan Terms</p>
    ${renderTermsSummaryHtml(terms, tokens)}
  </div>

  <p style="margin:20px 0;">
    <a href="${escape(link)}" style="display:inline-block;background:#dc2626;color:#fff;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">Review &amp; accept →</a>
  </p>
  <p style="${MUTED}">Castle Garage Inc · My Commission</p>
</div>`.trim()

  const text = [
    `A commission plan needs your acceptance`,
    ``,
    `Your commission plan for ${period} is ready. Log in to review the terms and accept:`,
    link,
  ].join('\n')

  return { subject, html, text }
}

function escape(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
