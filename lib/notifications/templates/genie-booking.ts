// Emails sent when a Genie / Home Depot customer books their install via the
// self-scheduler:
//   • renderGenieBookingConfirmation — branded confirmation TO the customer
//   • renderGenieBookingAlert        — internal "booking landed" alert to the
//     team (rides the same `scheduler_lead_synced` notification subscribers as
//     the main scheduler)

const LOGO_URL = 'https://www.castlegaragedoors.com/logo.png'
const FONTS = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@500;700&family=Source+Sans+3:wght@400;600&display=swap'
const DISPLAY = "'DM Sans',system-ui,-apple-system,sans-serif"
const BODY = "'Source Sans 3',system-ui,-apple-system,sans-serif"

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ── Customer confirmation (branded shell, matches the schedule-nudge email) ──
export function renderGenieBookingConfirmation(o: {
  greetingName: string | null
  dateLabel: string
  windowLabel: string
  address: string | null
}): { subject: string; html: string; text: string } {
  const hi = o.greetingName ? `Hi ${o.greetingName},` : 'Hi,'
  const subject = `Your garage door opener installation is scheduled — ${o.dateLabel}`

  const rows: Array<[string, string]> = [
    ['Date', o.dateLabel],
    ['Arrival window', o.windowLabel],
  ]
  if (o.address) rows.push(['Address', o.address])

  const text = `${hi}

You're all set — your garage door opener installation is scheduled.

${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}

Our technician will call ahead before arriving. Need to change something? Call us at (800) 576-1397.

— Castle Team`

  const rowsHtml = rows.map(([k, v]) => `
      <p style="font-size:12px; font-weight:600; color:#6B6B6B; text-transform:uppercase; letter-spacing:0.04em; margin:0 0 2px;">${esc(k)}</p>
      <p style="font-size:15px; color:#1A1A1A; margin:0 0 14px;">${esc(v)}</p>`).join('')

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link href="${FONTS}" rel="stylesheet"></head>
<body style="margin:0; background:#F5F5F3; padding:24px; font-family:${BODY}; color:#1A1A1A;">
  <div style="max-width:560px; margin:0 auto; background:#FFFFFF; border-radius:12px; overflow:hidden; border:1px solid #E2E0DC;">
    <div style="background:#FFFFFF; padding:24px 28px 18px; text-align:center; border-bottom:3px solid #C81E1E;">
      <img src="${LOGO_URL}" alt="Castle Garage Doors and Gates" style="width:260px; max-width:80%; height:auto;">
    </div>
    <div style="padding:28px;">
      <p style="font-size:16px; color:#1A1A1A; line-height:1.6; margin:0 0 8px;">${esc(hi)}</p>
      <p style="font-family:${DISPLAY}; font-size:19px; font-weight:700; color:#1A1A1A; margin:0 0 18px;">You&rsquo;re all set &mdash; your installation is scheduled.</p>
      ${rowsHtml}
      <p style="font-size:15px; color:#1A1A1A; line-height:1.6; margin:16px 0 0;">
        Our technician will call ahead before arriving. Need to change something? Call us at (800) 576-1397.
      </p>
    </div>
    <div style="background:#0F0F0F; padding:20px 28px;">
      <p style="font-family:${DISPLAY}; font-weight:700; font-size:13px; color:#FFFFFF; margin:0 0 4px; letter-spacing:0.3px;">Castle Team</p>
      <p style="font-size:12px; color:#8A8A94; margin:0; line-height:1.5;">Family-owned &amp; operated since 1981 &mdash; serving San Diego to Riverside County &middot; CSLB #1154002<br>(800) 576-1397 &middot; castlegaragedoors.com</p>
    </div>
  </div>
</body>
</html>`

  return { subject, html, text }
}

// ── Internal team alert (plain style, matches scheduler_lead_synced) ─────────
const A_BASE = `font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #111827; max-width: 560px; margin: 0 auto; padding: 32px 24px;`
const A_HEADING = `font-size: 20px; font-weight: 700; margin: 0 0 16px;`
const A_LABEL = `font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em;`
const A_VALUE = `font-size: 15px; margin: 2px 0 12px;`
const A_BTN = `display:inline-block; background:#111827; color:#ffffff; padding:11px 22px; border-radius:6px; text-decoration:none; font-weight:600; font-size:14px;`

export function renderGenieBookingAlert(o: {
  customerName: string | null
  phone: string | null
  email: string | null
  hdOrder: string
  sfJobNumber: string | null
  dateLabel: string
  windowLabel: string
  address: string | null
  adminUrl: string
}): { subject: string; bodyHtml: string; bodyText: string } {
  const name = o.customerName || `HD #${o.hdOrder}`
  const subject = `Genie install booked: ${name} — ${o.dateLabel}`
  const contact = [o.phone, o.email].filter(Boolean).join(' · ')

  const fields: Array<[string, string]> = [
    ['Customer', `${name}${contact ? ` · ${contact}` : ''}`],
    ['Home Depot order', `#${o.hdOrder}`],
    ['SF job', o.sfJobNumber ? `#${o.sfJobNumber}` : '—'],
    ['Date', o.dateLabel],
    ['Arrival window', o.windowLabel],
    ['Address', o.address || '—'],
  ]

  const bodyText = `Genie install booked via the self-scheduler.

${fields.map(([k, v]) => `${k}: ${v}`).join('\n')}

Manage: ${o.adminUrl}`

  const bodyHtml = `
<div style="${A_BASE}">
  <p style="${A_HEADING}">Genie install booked</p>
  ${fields.map(([k, v]) => `<p style="${A_LABEL}">${esc(k)}</p><p style="${A_VALUE}">${esc(v)}</p>`).join('')}
  <p style="margin:20px 0 0;"><a href="${esc(o.adminUrl)}" style="${A_BTN}">Open HD Orders</a></p>
</div>`

  return { subject, bodyHtml, bodyText }
}
