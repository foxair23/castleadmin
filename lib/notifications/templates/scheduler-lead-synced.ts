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
const NOTES_BOX = `font-size: 13px; color: #374151; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px 14px; margin: 2px 0 12px; white-space: pre-wrap; line-height: 1.6;`
const MUTED = `font-size: 13px; color: #6b7280; margin: 24px 0 0;`

export interface SchedulerLeadSyncedData {
  customerName: string
  phone: string
  email: string | null
  serviceLabel: string
  appointmentDate: string
  appointmentWindow: string
  address: string
  sfJobId: string
  sfCustomerId: string
  notes: string        // full description/notes sent to SF
  adminUrl: string
}

export function renderSchedulerLeadSynced(data: SchedulerLeadSyncedData): {
  subject: string
  bodyHtml: string
  bodyText: string
} {
  const subject = `Booking synced to SF: ${data.customerName} — ${data.appointmentDate}`

  const bodyHtml = `
<div style="${BASE}">
  <p style="${HEADING}">Booking Synced to Service Fusion</p>

  <p style="${LABEL}">Customer</p>
  <p style="${VALUE}">${data.customerName}${data.phone ? ` · ${data.phone}` : ''}${data.email ? ` · ${data.email}` : ''}</p>

  <p style="${LABEL}">Service</p>
  <p style="${VALUE}">${data.serviceLabel}</p>

  <p style="${LABEL}">Appointment</p>
  <p style="${VALUE}">${data.appointmentDate}, ${data.appointmentWindow}</p>

  <p style="${LABEL}">Address</p>
  <p style="${VALUE}">${data.address}</p>

  <p style="${LABEL}">SF Job / Customer</p>
  <p style="${VALUE}">Job #${data.sfJobId} · Customer #${data.sfCustomerId}</p>

  <p style="${LABEL}">Notes sent to SF</p>
  <pre style="${NOTES_BOX}">${data.notes}</pre>

  <p style="${MUTED}">
    <a href="${data.adminUrl}" style="color: #dc2626;">View in Castle Admin →</a>
  </p>
</div>`.trim()

  const bodyText = [
    `Booking Synced to Service Fusion`,
    ``,
    `Customer: ${data.customerName}${data.phone ? ` / ${data.phone}` : ''}${data.email ? ` / ${data.email}` : ''}`,
    `Service: ${data.serviceLabel}`,
    `Appointment: ${data.appointmentDate}, ${data.appointmentWindow}`,
    `Address: ${data.address}`,
    `SF Job #${data.sfJobId} · Customer #${data.sfCustomerId}`,
    ``,
    `Notes sent to SF:`,
    data.notes,
  ].join('\n')

  return { subject, bodyHtml, bodyText }
}
