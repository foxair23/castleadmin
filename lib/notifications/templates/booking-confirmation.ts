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

export interface BookingConfirmationData {
  customerFirstName: string
  serviceLabel: string       // e.g. "Garage Door — Repairs & Service"
  appointmentDate: string    // e.g. "Monday, June 9"
  appointmentWindow: string  // e.g. "8:00 AM – 12:00 PM"
  address: string            // e.g. "123 Main St, Burbank, CA 91502"
  quotedFee: string          // e.g. "$99 Service Call Fee" or "Free Estimate"
}

export function renderBookingConfirmation(data: BookingConfirmationData): {
  subject: string
  bodyHtml: string
  bodyText: string
} {
  const subject = `Your appointment request has been received — ${data.appointmentDate}`

  const bodyHtml = `
<div style="${BASE}">
  <p style="${HEADING}">We've received your appointment request.</p>
  <p style="${SUBHEAD}">A member of the Castle team will be in touch to confirm your appointment as soon as possible.</p>

  <p style="${LABEL}">Service</p>
  <p style="${VALUE}">${data.serviceLabel}</p>

  <p style="${LABEL}">Requested Date</p>
  <p style="${VALUE}">${data.appointmentDate}</p>

  <p style="${LABEL}">Arrival Window</p>
  <p style="${VALUE}">${data.appointmentWindow}</p>

  <p style="${LABEL}">Address</p>
  <p style="${VALUE}">${data.address}</p>

  <p style="${LABEL}">Fee</p>
  <p style="${VALUE}">${data.quotedFee}</p>

  <hr style="${DIVIDER}" />

  <p style="${MUTED}">
    Please call our office if you have further questions.<br/>
    Castle Garage Doors &amp; Gates
  </p>
</div>`.trim()

  const bodyText = [
    `We've received your appointment request — ${data.appointmentDate}`,
    ``,
    `Hi ${data.customerFirstName},`,
    ``,
    `A member of the Castle team will be in touch to confirm your appointment as soon as possible.`,
    ``,
    `Service:          ${data.serviceLabel}`,
    `Requested Date:   ${data.appointmentDate}`,
    `Arrival Window:   ${data.appointmentWindow}`,
    `Address:          ${data.address}`,
    `Fee:              ${data.quotedFee}`,
    ``,
    `Please call our office if you have further questions.`,
    `Castle Garage Doors & Gates`,
  ].join('\n')

  return { subject, bodyHtml, bodyText }
}

function pad(n: number) { return String(n).padStart(2, '0') }

export function formatTimeWindow(start: string, end: string): string {
  const fmt = (t: string) => {
    const [h, m] = t.split(':').map(Number)
    const ampm = h < 12 ? 'AM' : 'PM'
    const h12 = h % 12 || 12
    return m === 0 ? `${h12} ${ampm}` : `${h12}:${pad(m)} ${ampm}`
  }
  return `${fmt(start)} – ${fmt(end)}`
}
