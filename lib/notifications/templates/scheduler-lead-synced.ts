const BASE = `
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: #111827;
  max-width: 560px;
  margin: 0 auto;
  padding: 32px 24px;
`
const HEADING = `font-size: 20px; font-weight: 700; margin: 0 0 16px;`
const LABEL = `font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em;`
const VALUE = `font-size: 15px; margin: 2px 0 12px;`
const MUTED = `font-size: 13px; color: #6b7280; margin: 24px 0 0;`

export interface SchedulerLeadSyncedData {
  customerName: string
  serviceLabel: string
  appointmentDate: string
  sfJobId: string
  adminUrl: string
}

export function renderSchedulerLeadSynced(data: SchedulerLeadSyncedData): {
  subject: string
  bodyHtml: string
  bodyText: string
} {
  const subject = `Booking synced to SF: ${data.customerName}`

  const bodyHtml = `
<div style="${BASE}">
  <p style="${HEADING}">Booking Synced to Service Fusion</p>

  <p style="${LABEL}">Customer</p>
  <p style="${VALUE}">${data.customerName}</p>

  <p style="${LABEL}">Service</p>
  <p style="${VALUE}">${data.serviceLabel}</p>

  <p style="${LABEL}">Appointment</p>
  <p style="${VALUE}">${data.appointmentDate}</p>

  <p style="${LABEL}">SF Job ID</p>
  <p style="${VALUE}">${data.sfJobId}</p>

  <p style="${MUTED}">
    <a href="${data.adminUrl}" style="color: #dc2626;">View in Castle Admin →</a>
  </p>
</div>`.trim()

  const bodyText = [
    `Booking Synced to Service Fusion`,
    ``,
    `Customer: ${data.customerName}`,
    `Service: ${data.serviceLabel}`,
    `Appointment: ${data.appointmentDate}`,
    `SF Job ID: ${data.sfJobId}`,
  ].join('\n')

  return { subject, bodyHtml, bodyText }
}
