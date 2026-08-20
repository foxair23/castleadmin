const BASE = `
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: #111827;
  max-width: 560px;
  margin: 0 auto;
  padding: 32px 24px;
`
const HEADING = `font-size: 20px; font-weight: 700; margin: 0 0 8px;`
const SUBHEAD = `font-size: 14px; color: #6b7280; margin: 0 0 24px;`
const LABEL = `font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em;`
const VALUE = `font-size: 15px; margin: 2px 0 14px;`
const DIVIDER = `border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;`
const MUTED = `font-size: 13px; color: #6b7280; margin: 24px 0 0; line-height: 1.5;`

export interface OnlineEstimateConfirmationData {
  customerFirstName: string
  serviceLabel: string // e.g. "Garage Door — New Door / Panel"
}

// Customer-facing confirmation for a Free Online Estimate submission — no
// appointment; we tell them we'll email their quote within 1–2 business days.
export function renderOnlineEstimateConfirmation(data: OnlineEstimateConfirmationData): {
  subject: string
  bodyHtml: string
  bodyText: string
} {
  const subject = "We've received your free online estimate request"

  const bodyHtml = `
<div style="${BASE}">
  <p style="${HEADING}">Thanks${data.customerFirstName ? `, ${data.customerFirstName}` : ''} — we've got your photos.</p>
  <p style="${SUBHEAD}">Our team will review them and email your estimate within <strong>1–2 business days</strong>.</p>

  <p style="${LABEL}">Service</p>
  <p style="${VALUE}">${data.serviceLabel}</p>

  <hr style="${DIVIDER}" />

  <p style="${MUTED}">
    This is a preliminary estimate, subject to onsite verification — especially where measurements,
    hidden damage, structural conditions, or additional required parts can't be confirmed from photos.
  </p>
  <p style="${MUTED}">
    Questions? Just reply to this email or call our office.<br/>
    Castle Garage Doors &amp; Gates
  </p>
</div>`.trim()

  const bodyText = [
    "We've received your free online estimate request",
    ``,
    `Hi ${data.customerFirstName},`,
    ``,
    `Thanks — we've got your photos. Our team will review them and email your estimate within 1–2 business days.`,
    ``,
    `Service: ${data.serviceLabel}`,
    ``,
    `This is a preliminary estimate, subject to onsite verification — especially where measurements, hidden damage, structural conditions, or additional required parts can't be confirmed from photos.`,
    ``,
    `Questions? Just reply to this email or call our office.`,
    `Castle Garage Doors & Gates`,
  ].join('\n')

  return { subject, bodyHtml, bodyText }
}
