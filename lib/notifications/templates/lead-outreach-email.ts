import { emailLogoUrl, emailFooterDomain } from '@/lib/config/domains'
// Branded first-touch email to a new inbound lead — Castle Garage design system.
// Same shell as the invoice-reminder email (white logo header, Castle Red rule,
// black footer) with a "Schedule Online" CTA instead of a pay button.

// Served from our own origin — the old marketing host is no longer ours.
const LOGO_URL = emailLogoUrl()
const FONTS = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@500;700&family=Source+Sans+3:wght@400;600&display=swap'
const DISPLAY = "'DM Sans',system-ui,-apple-system,sans-serif"
const BODY = "'Source Sans 3',system-ui,-apple-system,sans-serif"

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function renderLeadOutreachEmail(opts: {
  greetingName: string | null
  scheduleUrl: string          // e.g. "sfi.cstle.co"
}): { html: string; text: string } {
  const hi = opts.greetingName ? `Hi ${opts.greetingName},` : 'Hi,'
  const href = /^https?:\/\//i.test(opts.scheduleUrl) ? opts.scheduleUrl : `https://${opts.scheduleUrl}`

  const text = `${hi} this is Castle Garage Doors & Gates. We received your online service request from Home Depot and we'd be happy to help with your garage door or opener issue.

For Self Scheduling visit: ${opts.scheduleUrl}

Otherwise, please reply with the best day and time for service, or let us know if you would like us to call you to schedule.

Thank you,
Castle Team`

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
        This is Castle Garage Doors &amp; Gates. We received your online service request from Home Depot and we&rsquo;d be happy to help with your garage door or opener issue.
      </p>
      <div style="text-align:center; margin:24px 0;">
        <a href="${esc(href)}" style="display:inline-block; background:#C81E1E; color:#FFFFFF; text-decoration:none; font-family:${DISPLAY}; font-weight:700; font-size:16px; padding:15px 44px; border-radius:8px;">Schedule Online</a>
        <div style="font-size:13px; color:#64646E; margin-top:8px;">${esc(opts.scheduleUrl)}</div>
      </div>
      <p style="font-size:16px; color:#1A1A1A; line-height:1.6; margin:0;">
        Otherwise, please reply with the best day and time for service, or let us know if you&rsquo;d like us to call you to schedule.
      </p>
    </div>
    <div style="background:#0F0F0F; padding:20px 28px;">
      <p style="font-family:${DISPLAY}; font-weight:700; font-size:13px; color:#FFFFFF; margin:0 0 4px; letter-spacing:0.3px;">Castle Team</p>
      <p style="font-size:12px; color:#8A8A94; margin:0; line-height:1.5;">Family-owned &amp; operated since 1981 &mdash; serving San Diego to Riverside County &middot; CSLB #1154002<br>(800) 576-1397 &middot; ${emailFooterDomain()}</p>
    </div>
  </div>
</body>
</html>`

  return { html, text }
}
