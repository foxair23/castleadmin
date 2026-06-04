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

export interface LeadAssignedData {
  customerName: string
  phone: string
  email: string | null
  serviceLabel: string  // e.g. "Garage Door — Repairs & Service"
  appointmentDate: string // e.g. "Monday, June 9"
  appointmentWindow: string // e.g. "8:00 AM – 10:00 AM"
  address: string
  quotedFee: string | null
  notes: string | null
  adminUrl: string
}

export function renderLeadAssigned(data: LeadAssignedData): {
  subject: string
  bodyHtml: string
  bodyText: string
} {
  const subject = `New booking: ${data.customerName} on ${data.appointmentDate}`

  const bodyHtml = `
<div style="${BASE}">
  <p style="${HEADING}">New Scheduler Booking</p>

  <p style="${LABEL}">Customer</p>
  <p style="${VALUE}">${data.customerName}</p>

  <p style="${LABEL}">Phone</p>
  <p style="${VALUE}">${data.phone}${data.email ? ` · ${data.email}` : ''}</p>

  <p style="${LABEL}">Service</p>
  <p style="${VALUE}">${data.serviceLabel}</p>

  <p style="${LABEL}">Appointment</p>
  <p style="${VALUE}">${data.appointmentDate}, ${data.appointmentWindow}</p>

  <p style="${LABEL}">Address</p>
  <p style="${VALUE}">${data.address}</p>

  ${data.quotedFee ? `<p style="${LABEL}">Fee Quoted</p><p style="${VALUE}">${data.quotedFee}</p>` : ''}
  ${data.notes ? `<p style="${LABEL}">Notes</p><p style="${VALUE}">${data.notes}</p>` : ''}

  <p style="${MUTED}">
    View in <a href="${data.adminUrl}" style="color: #dc2626;">Castle Admin → Scheduler</a>
  </p>
</div>`.trim()

  const lines = [
    `New Scheduler Booking`,
    ``,
    `Customer: ${data.customerName}`,
    `Phone: ${data.phone}${data.email ? ` / ${data.email}` : ''}`,
    `Service: ${data.serviceLabel}`,
    `Appointment: ${data.appointmentDate}, ${data.appointmentWindow}`,
    `Address: ${data.address}`,
  ]
  if (data.quotedFee) lines.push(`Fee Quoted: ${data.quotedFee}`)
  if (data.notes) lines.push(`Notes: ${data.notes}`)

  return { subject, bodyHtml, bodyText: lines.join('\n') }
}
