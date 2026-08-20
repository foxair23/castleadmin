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
const BTN = `display: inline-block; background: #dc2626; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 14px;`

export interface OnlineEstimateAlertData {
  customerName: string
  phone: string
  email: string
  serviceLabel: string
  address: string
  estimateNumber?: string // SF estimate # if it was created; absent ⇒ review-only
  adminUrl: string
}

// Team alert when a customer submits a Free Online Estimate — points the rep at
// the SF estimate to price (or flags that SF creation failed and it needs a
// manual estimate).
export function renderOnlineEstimateAlert(data: OnlineEstimateAlertData): {
  subject: string
  bodyHtml: string
  bodyText: string
} {
  const subject = `New online estimate request — ${data.customerName || 'customer'}`
  const sfLine = data.estimateNumber
    ? `Service Fusion Estimate #${data.estimateNumber} — open it in SF to add pricing.`
    : `Not created in Service Fusion (create the estimate manually).`

  const bodyHtml = `
<div style="${BASE}">
  <p style="${HEADING}">New online estimate request</p>
  <p style="${SUBHEAD}">A customer sent photos for a free online estimate. Review and send them a price.</p>

  <p style="${LABEL}">Customer</p>
  <p style="${VALUE}">${data.customerName || '—'}</p>

  <p style="${LABEL}">Phone</p>
  <p style="${VALUE}">${data.phone || '—'}</p>

  <p style="${LABEL}">Email</p>
  <p style="${VALUE}">${data.email || '—'}</p>

  <p style="${LABEL}">Service</p>
  <p style="${VALUE}">${data.serviceLabel}</p>

  <p style="${LABEL}">Address</p>
  <p style="${VALUE}">${data.address || '—'}</p>

  <p style="${LABEL}">Service Fusion</p>
  <p style="${VALUE}">${sfLine}</p>

  <hr style="${DIVIDER}" />
  <p><a href="${data.adminUrl}" style="${BTN}">Open Online Estimates →</a></p>
</div>`.trim()

  const bodyText = [
    `New online estimate request`,
    ``,
    `Customer: ${data.customerName || '—'}`,
    `Phone:    ${data.phone || '—'}`,
    `Email:    ${data.email || '—'}`,
    `Service:  ${data.serviceLabel}`,
    `Address:  ${data.address || '—'}`,
    `SF:       ${sfLine}`,
    ``,
    `Open Online Estimates: ${data.adminUrl}`,
  ].join('\n')

  return { subject, bodyHtml, bodyText }
}
