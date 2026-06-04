const BASE = `
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: #111827;
  max-width: 560px;
  margin: 0 auto;
  padding: 32px 24px;
`
const HEADING = `font-size: 20px; font-weight: 700; margin: 0 0 8px;`
const SUBHEADING = `font-size: 15px; color: #6b7280; margin: 0 0 24px;`
const LABEL = `font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; margin: 0 0 6px;`
const ROW = `font-size: 14px; border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px 14px; margin: 0 0 8px; background: #f9fafb;`
const NAME = `font-weight: 600; color: #111827;`
const DETAIL = `color: #6b7280; font-size: 13px; margin-top: 2px;`
const BTN = `display: inline-block; background: #dc2626; color: #ffffff; font-size: 15px; font-weight: 600; text-decoration: none; padding: 12px 24px; border-radius: 6px; margin: 16px 0 8px;`
const MUTED = `font-size: 13px; color: #6b7280; margin: 20px 0 0;`

export interface LeadAssignedLead {
  customerName: string
  phone: string | null
  email: string | null
}

export interface LeadAssignedData {
  repFirstName: string
  tagName: string       // e.g. "Opener Special" — the campaign/tag name
  totalCount: number    // total leads assigned
  leads: LeadAssignedLead[]  // first N leads to preview in email
  salesUrl: string
}

export function renderLeadAssigned(data: LeadAssignedData): {
  subject: string
  bodyHtml: string
  bodyText: string
} {
  const plural = data.totalCount === 1 ? 'prospect' : 'prospects'
  const subject = `${data.totalCount} new ${plural} assigned to you — ${data.tagName}`

  const leadRows = data.leads.map(l => {
    const details = [l.phone, l.email].filter(Boolean).join(' · ')
    return `
  <div style="${ROW}">
    <div style="${NAME}">${l.customerName}</div>
    ${details ? `<div style="${DETAIL}">${details}</div>` : ''}
  </div>`
  }).join('')

  const remaining = data.totalCount - data.leads.length
  const moreNote = remaining > 0
    ? `<p style="font-size: 13px; color: #6b7280; margin: 4px 0 0;">…and ${remaining} more in Castle Admin</p>`
    : ''

  const bodyHtml = `
<div style="${BASE}">
  <p style="${HEADING}">New Prospects Assigned</p>
  <p style="${SUBHEADING}">Hi ${data.repFirstName} — you have ${data.totalCount} new ${plural} from the <strong>${data.tagName}</strong> campaign ready to call.</p>

  <p style="${LABEL}">Your prospects</p>
  ${leadRows}
  ${moreNote}

  <a href="${data.salesUrl}" style="${BTN}">View in Castle Admin →</a>

  <p style="${MUTED}">Log in and navigate to the Sales section to see full contact details, call history, and notes.</p>
</div>`.trim()

  const lines = [
    `New Prospects Assigned`,
    ``,
    `Hi ${data.repFirstName} — you have ${data.totalCount} new ${plural} from the "${data.tagName}" campaign ready to call.`,
    ``,
    `Prospects:`,
    ...data.leads.map(l => {
      const detail = [l.phone, l.email].filter(Boolean).join(' / ')
      return `  • ${l.customerName}${detail ? ` — ${detail}` : ''}`
    }),
    ...(remaining > 0 ? [`  …and ${remaining} more`] : []),
    ``,
    `View in Castle Admin: ${data.salesUrl}`,
  ]

  return { subject, bodyHtml, bodyText: lines.join('\n') }
}
