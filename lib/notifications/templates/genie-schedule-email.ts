// Branded email nudging a Genie / Home Depot customer to schedule their garage
// door opener install. Same Castle design-system shell as the invoice-reminder /
// lead-outreach emails (white logo header, Castle Red rule, black footer) with a
// "Schedule My Installation" CTA.

const LOGO_URL = 'https://www.castlegaragedoors.com/logo.png'
const FONTS = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@500;700&family=Source+Sans+3:wght@400;600&display=swap'
const DISPLAY = "'DM Sans',system-ui,-apple-system,sans-serif"
const BODY = "'Source Sans 3',system-ui,-apple-system,sans-serif"

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function renderGenieScheduleEmail(opts: {
  greetingName: string | null
  scheduleUrl: string
}): { subject: string; html: string; text: string } {
  const hi = opts.greetingName ? `Hi ${opts.greetingName},` : 'Hi,'
  const href = /^https?:\/\//i.test(opts.scheduleUrl) ? opts.scheduleUrl : `https://${opts.scheduleUrl}`
  const subject = 'Schedule your garage door opener installation'

  const text = `${hi}

Thank you for your garage door opener purchase through Home Depot. Castle Garage Doors & Gates will be handling your installation — the last step is to pick a time that works for you.

Scheduling takes about a minute: you'll confirm your order, answer a few quick questions about your garage, and choose a date.

Schedule your installation: ${opts.scheduleUrl}

Questions? Call us at (800) 576-1397 or just reply to this email.

— Castle Team`

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
      <p style="font-size:16px; color:#1A1A1A; line-height:1.6; margin:0 0 16px;">${esc(hi)}</p>
      <p style="font-size:16px; color:#1A1A1A; line-height:1.6; margin:0 0 16px;">
        Thank you for your garage door opener purchase through Home Depot. Castle Garage Doors &amp; Gates will be handling your installation &mdash; the last step is to pick a time that works for you.
      </p>
      <p style="font-size:16px; color:#1A1A1A; line-height:1.6; margin:0 0 16px;">
        Scheduling takes about a minute: you&rsquo;ll confirm your order, answer a few quick questions about your garage, and choose a date.
      </p>
      <div style="text-align:center; margin:24px 0;">
        <a href="${esc(href)}" style="display:inline-block; background:#C81E1E; color:#FFFFFF; text-decoration:none; font-family:${DISPLAY}; font-weight:700; font-size:16px; padding:15px 44px; border-radius:8px;">Schedule My Installation</a>
        <div style="font-size:13px; color:#64646E; margin-top:8px;">${esc(opts.scheduleUrl)}</div>
      </div>
      <p style="font-size:16px; color:#1A1A1A; line-height:1.6; margin:0;">
        Questions? Call us at (800) 576-1397 or just reply to this email.
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

/** First-touch SMS. `scheduleUrl` is a short link (e.g. cstle.co/…). */
export function renderGenieScheduleSms(scheduleUrl: string): string {
  return `Castle Garage Doors: Thanks for your Home Depot garage door opener purchase! Your installation is ready to schedule — pick a time here: ${scheduleUrl}. Questions? Call (800) 576-1397. Reply STOP to opt out.`
}
