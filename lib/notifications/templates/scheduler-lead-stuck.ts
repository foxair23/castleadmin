const BASE = `
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: #111827;
  max-width: 560px;
  margin: 0 auto;
  padding: 32px 24px;
`
const HEADING = `font-size: 20px; font-weight: 700; margin: 0 0 16px; color: #b91c1c;`
const LABEL = `font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em;`
const VALUE = `font-size: 15px; margin: 2px 0 12px;`
const MUTED = `font-size: 13px; color: #6b7280; margin: 24px 0 0;`

export type StuckReason = 'sync_failed' | 'manual_push'

export interface SchedulerLeadStuckData {
  customerName: string
  phoneNumber?: string
  serviceLabel: string
  appointmentDate: string
  reason: StuckReason
  errorMessage?: string
  adminUrl: string
  ackUrl?: string      // "Done" acknowledgement link (requires Castle Admin login)
}

const DONE_BTN = `display:inline-block; background:#16a34a; color:#ffffff; padding:11px 22px; border-radius:6px; text-decoration:none; font-weight:600; font-size:14px;`

export function renderSchedulerLeadStuck(data: SchedulerLeadStuckData): {
  subject: string
  bodyHtml: string
  bodyText: string
} {
  const reasonLabel =
    data.reason === 'manual_push'
      ? 'Awaiting manual push to Service Fusion'
      : 'Sync to Service Fusion failed'

  const subject = `Action needed: ${reasonLabel} — ${data.customerName}`

  const bodyHtml = `
<div style="${BASE}">
  <p style="${HEADING}">Scheduler Lead Needs Attention</p>

  <p style="${LABEL}">Issue</p>
  <p style="${VALUE}">${reasonLabel}</p>

  <p style="${LABEL}">Customer</p>
  <p style="${VALUE}">${data.customerName}</p>

  ${data.phoneNumber ? `<p style="${LABEL}">Phone</p><p style="${VALUE}">${data.phoneNumber}</p>` : ''}

  <p style="${LABEL}">Service</p>
  <p style="${VALUE}">${data.serviceLabel}</p>

  <p style="${LABEL}">Appointment</p>
  <p style="${VALUE}">${data.appointmentDate}</p>

  ${data.errorMessage ? `<p style="${LABEL}">Error</p><p style="${VALUE}; color: #dc2626;">${data.errorMessage}</p>` : ''}

  ${data.ackUrl ? `<p style="margin: 24px 0 4px;"><a href="${data.ackUrl}" style="${DONE_BTN}">✓ Done</a></p>
  <p style="font-size: 12px; color: #9ca3af; margin: 0 0 8px;">Marks this lead acknowledged (requires Castle Admin login).</p>` : ''}

  <p style="${MUTED}">
    <a href="${data.adminUrl}" style="color: #dc2626;">View in Castle Admin → Scheduler →</a>
  </p>
</div>`.trim()

  const lines = [
    `Scheduler Lead Needs Attention`,
    ``,
    `Issue: ${reasonLabel}`,
    `Customer: ${data.customerName}`,
    ...(data.phoneNumber ? [`Phone: ${data.phoneNumber}`] : []),
    `Service: ${data.serviceLabel}`,
    `Appointment: ${data.appointmentDate}`,
  ]
  if (data.errorMessage) lines.push(`Error: ${data.errorMessage}`)
  if (data.ackUrl) lines.push('', `Done (acknowledge, requires login): ${data.ackUrl}`)

  return { subject, bodyHtml, bodyText: lines.join('\n') }
}
