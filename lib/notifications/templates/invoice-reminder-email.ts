// Branded invoice-reminder email — Castle Garage design system.
// Two colors only (Castle Black #0F0F0F, Castle Red #C81E1E), DM Sans display /
// Source Sans 3 body, logo on a white header, black footer. The per-stage
// message text drops into the body; the shell (amount callout, Pay button,
// footer) stays consistent so the copy can escalate stage to stage.

const LOGO_URL = 'https://www.castlegaragedoors.com/logo.png'
const FONTS = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@500;700&family=Source+Sans+3:wght@400;600&display=swap'
const DISPLAY = "'DM Sans',system-ui,-apple-system,sans-serif"
const BODY = "'Source Sans 3',system-ui,-apple-system,sans-serif"

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function renderInvoiceReminderEmail(opts: {
  bodyText: string       // per-stage message, placeholders already substituted
  invoiceNumber: string
  amountDue: string      // pre-formatted, e.g. "$450.00"
  payUrl: string
}): { html: string; text: string } {
  // Body is plain text; support **bold** (converted after escaping, so real HTML
  // in the copy is still neutralized).
  const fmt = (p: string) => esc(p).replace(/\n/g, '<br>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  const paragraphs = opts.bodyText.trim().split(/\n\n+/)
    .map(p => `<p style="font-size:16px; color:#1A1A1A; line-height:1.6; margin:0 0 16px;">${fmt(p)}</p>`)
    .join('')

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
      ${paragraphs}
      <div style="background:#F7F7F5; border:1px solid #E2E0DC; border-left:4px solid #C81E1E; border-radius:8px; padding:16px 18px; margin:6px 0 24px;">
        <table style="width:100%; font-size:15px; color:#64646E;">
          <tr><td style="padding:3px 0;">Invoice</td><td style="text-align:right; font-weight:600; color:#1A1A1A;">${esc(opts.invoiceNumber)}</td></tr>
          <tr><td style="padding:3px 0;">Balance due</td><td style="text-align:right; font-family:${DISPLAY}; font-weight:700; color:#C81E1E; font-size:22px;">${esc(opts.amountDue)}</td></tr>
        </table>
      </div>
      ${opts.payUrl ? `<div style="text-align:center; margin:0 0 24px;">
        <a href="${esc(opts.payUrl)}" style="display:inline-block; background:#C81E1E; color:#FFFFFF; text-decoration:none; font-family:${DISPLAY}; font-weight:700; font-size:16px; padding:15px 44px; border-radius:8px;">Pay Invoice</a>
      </div>` : ''}
      <p style="font-size:14px; color:#64646E; line-height:1.6; margin:0;">
        If you have already paid, please disregard this notice. Questions about your invoice? Reply to this email or call us at (800)&nbsp;576-1397.
      </p>
    </div>
    <div style="background:#0F0F0F; padding:20px 28px;">
      <p style="font-family:${DISPLAY}; font-weight:700; font-size:13px; color:#FFFFFF; margin:0 0 4px; letter-spacing:0.3px;">Castle Garage Inc</p>
      <p style="font-size:12px; color:#8A8A94; margin:0; line-height:1.5;">Family-owned &amp; operated since 1981 &mdash; serving San Diego to Riverside County &middot; CSLB #1154002<br>(800) 576-1397 &middot; castlegaragedoors.com</p>
    </div>
  </div>
</body>
</html>`

  const text = [
    opts.bodyText.trim(),
    '',
    `Invoice: ${opts.invoiceNumber}`,
    `Balance due: ${opts.amountDue}`,
    ...(opts.payUrl ? [`Pay online: ${opts.payUrl}`] : []),
    '',
    'If you have already paid, please disregard this notice. Questions? Call (800) 576-1397.',
    '',
    'Castle Garage Inc',
    'Family-owned & operated since 1981 — serving San Diego to Riverside County · CSLB #1154002',
    '(800) 576-1397 · castlegaragedoors.com',
  ].join('\n')

  return { html, text }
}
