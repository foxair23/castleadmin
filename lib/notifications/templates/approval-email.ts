import { emailLogoUrl, emailFooterDomain } from '@/lib/config/domains'
// Branded customer-approval email — Castle Garage design system (same shell as
// invoice-reminder-email.ts: Castle Black #0F0F0F / Castle Red #C81E1E, DM Sans
// display / Source Sans 3 body, logo header, black footer). Shows the itemized
// quote and a red "Review & Approve" CTA to the tokenized approval link.

// Served from our own origin — the old marketing host is no longer ours.
const LOGO_URL = emailLogoUrl()
const FONTS = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@500;700&family=Source+Sans+3:wght@400;600&display=swap'
const DISPLAY = "'DM Sans',system-ui,-apple-system,sans-serif"
const BODY = "'Source Sans 3',system-ui,-apple-system,sans-serif"

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function renderApprovalEmail(opts: {
  customerName: string | null
  jobNumber: string | null
  descriptionHtml?: string // pre-rendered work-description block (renderDescriptionHtml)
  descriptionText?: string | null // raw description for the plain-text part
  itemsHtml: string        // pre-rendered itemized table (renderItemsTableHtml)
  approveUrl: string
}): { html: string; text: string } {
  const greeting = opts.customerName ? `Hi ${esc(opts.customerName)},` : 'Hello,'
  const jobLine = opts.jobNumber ? ` for Job ${esc(opts.jobNumber)}` : ''
  const descBlock = opts.descriptionHtml
    ? `<div style="margin:6px 0 18px;">${opts.descriptionHtml}</div>`
    : ''

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
      <p style="font-size:16px; color:#1A1A1A; line-height:1.6; margin:0 0 16px;">${greeting}</p>
      <p style="font-size:16px; color:#1A1A1A; line-height:1.6; margin:0 0 16px;">
        Please review and approve the following work${jobLine} before we begin. Tap the button below to review the
        details and add your approval.
      </p>
      ${descBlock}
      <div style="background:#F7F7F5; border:1px solid #E2E0DC; border-radius:8px; padding:12px 14px; margin:6px 0 24px;">
        ${opts.itemsHtml}
      </div>
      <div style="text-align:center; margin:0 0 24px;">
        <a href="${esc(opts.approveUrl)}" style="display:inline-block; background:#C81E1E; color:#FFFFFF; text-decoration:none; font-family:${DISPLAY}; font-weight:700; font-size:16px; padding:15px 44px; border-radius:8px;">Review &amp; Approve</a>
      </div>
      <p style="font-size:14px; color:#64646E; line-height:1.6; margin:0;">
        Questions about this quote? Reply to this email or call us at (800)&nbsp;576-1397.
      </p>
    </div>
    <div style="background:#0F0F0F; padding:20px 28px;">
      <p style="font-family:${DISPLAY}; font-weight:700; font-size:13px; color:#FFFFFF; margin:0 0 4px; letter-spacing:0.3px;">Castle Garage Inc</p>
      <p style="font-size:12px; color:#8A8A94; margin:0; line-height:1.5;">Family-owned &amp; operated since 1981 &mdash; serving San Diego to Riverside County &middot; CSLB #1154002<br>(800) 576-1397 &middot; ${emailFooterDomain()}</p>
    </div>
  </div>
</body>
</html>`

  const text = [
    opts.customerName ? `Hi ${opts.customerName},` : 'Hello,',
    '',
    `Please review and approve the following work${opts.jobNumber ? ` for Job ${opts.jobNumber}` : ''} before we begin:`,
    ...(opts.descriptionText && opts.descriptionText.trim() ? ['', `Work description: ${opts.descriptionText.trim()}`] : []),
    '',
    `Review & approve online: ${opts.approveUrl}`,
    '',
    'Questions about this quote? Reply to this email or call (800) 576-1397.',
    '',
    'Castle Garage Inc',
    'Family-owned & operated since 1981 — serving San Diego to Riverside County · CSLB #1154002',
    `(800) 576-1397 · ${emailFooterDomain()}`,
  ].join('\n')

  return { html, text }
}

// Confirmation sent to the customer once they approve — the record of exactly
// what they approved, plus their typed signature and timestamp. BCC'd to
// compliance so it doubles as the staff notification.
export function renderApprovalConfirmationEmail(opts: {
  customerName: string | null
  jobNumber: string | null
  descriptionHtml?: string
  itemsHtml: string
  approvedName: string
  approvedAt: string       // human-readable, PT
  ip?: string | null
  userAgent?: string | null
  fingerprint?: string | null
  legalVersion?: string | null
}): { html: string; text: string } {
  const greeting = opts.customerName ? `Hi ${esc(opts.customerName)},` : 'Hello,'
  const jobLine = opts.jobNumber ? ` for Job ${esc(opts.jobNumber)}` : ''

  // The tamper-evident record we stamped: signer, time, IP, device, plus a
  // fingerprint (SHA-256 digest of exactly what was approved) so the customer
  // can see this is a recorded, verifiable approval.
  const recRow = (k: string, v: string) =>
    `<tr><td style="padding:3px 12px 3px 0;font-size:12px;color:#8A8A94;white-space:nowrap;vertical-align:top;">${esc(k)}</td>` +
    `<td style="padding:3px 0;font-size:12px;color:#1A1A1A;word-break:break-word;">${esc(v)}</td></tr>`
  const recordRows =
    recRow('Approved by', opts.approvedName) +
    recRow('Date & time', opts.approvedAt) +
    (opts.ip ? recRow('IP address', opts.ip) : '') +
    (opts.userAgent ? recRow('Device', opts.userAgent) : '') +
    (opts.fingerprint ? recRow('Reference', opts.fingerprint + (opts.legalVersion ? ` · v${opts.legalVersion}` : '')) : '')

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
      <p style="font-size:16px; color:#1A1A1A; line-height:1.6; margin:0 0 16px;">${greeting}</p>
      <p style="font-size:16px; color:#1A1A1A; line-height:1.6; margin:0 0 16px;">
        Thank you — your approval${jobLine} has been recorded. Here is a copy for your records.
      </p>
      ${opts.descriptionHtml ? `<div style="margin:6px 0 16px;">${opts.descriptionHtml}</div>` : ''}
      <div style="background:#F7F7F5; border:1px solid #E2E0DC; border-radius:8px; padding:12px 14px; margin:6px 0 20px;">
        ${opts.itemsHtml}
      </div>
      <p style="font-size:13px; font-weight:700; color:#1A1A1A; margin:0 0 8px;">Approval record</p>
      <div style="border:1px solid #E2E0DC; border-left:4px solid #C81E1E; border-radius:6px; padding:12px 14px;">
        <table style="border-collapse:collapse;">${recordRows}</table>
      </div>
      <p style="font-size:12px; color:#8A8A94; line-height:1.6; margin:14px 0 0;">
        This confirmation, your typed signature, and the details above are stored as a permanent record of your approval.
      </p>
    </div>
    <div style="background:#0F0F0F; padding:20px 28px;">
      <p style="font-family:${DISPLAY}; font-weight:700; font-size:13px; color:#FFFFFF; margin:0 0 4px; letter-spacing:0.3px;">Castle Garage Inc</p>
      <p style="font-size:12px; color:#8A8A94; margin:0; line-height:1.5;">Family-owned &amp; operated since 1981 &mdash; serving San Diego to Riverside County &middot; CSLB #1154002<br>(800) 576-1397 &middot; ${emailFooterDomain()}</p>
    </div>
  </div>
</body>
</html>`

  const text = [
    opts.customerName ? `Hi ${opts.customerName},` : 'Hello,',
    '',
    `Thank you — your approval${opts.jobNumber ? ` for Job ${opts.jobNumber}` : ''} has been recorded.`,
    '',
    'Approval record:',
    `  Approved by: ${opts.approvedName}`,
    `  Date & time: ${opts.approvedAt}`,
    ...(opts.ip ? [`  IP address: ${opts.ip}`] : []),
    ...(opts.userAgent ? [`  Device: ${opts.userAgent}`] : []),
    ...(opts.fingerprint ? [`  Reference: ${opts.fingerprint}${opts.legalVersion ? ` · v${opts.legalVersion}` : ''}`] : []),
    '',
    'This confirmation, your typed signature, and the details above are stored as a permanent record of your approval.',
    '',
    'Castle Garage Inc',
    `(800) 576-1397 · ${emailFooterDomain()}`,
  ].join('\n')

  return { html, text }
}
