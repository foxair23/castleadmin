import { emailLogoUrl, emailFooterDomain } from '@/lib/config/domains'
import type { TemplateService } from '@/lib/esign/templates'
import type { CustomerStage } from '@/lib/esign/eligibility'

// The e-sign messages. INSTALL copy approved by the owner 2026-09-09 and pinned verbatim.
// DELIVERY copy (the homedepot.com proof-of-delivery waiver — we deliver the door, we do not
// install it) mirrors it word for word with the service swapped.
//
// Home Depot forbids asking for the signature before the work is done: the heads-up says so
// in plain words and asks the customer to come back once the install/delivery is complete.

const LOGO_URL = emailLogoUrl()
const FONTS = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@500;700&family=Source+Sans+3:wght@400;600&display=swap'
const DISPLAY = "'DM Sans',system-ui,-apple-system,sans-serif"
const BODY = "'Source Sans 3',system-ui,-apple-system,sans-serif"
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

interface Words { work: string; form: string; formShort: string }
const WORDS: Record<TemplateService, Words> = {
  install: { work: 'garage door installation', form: 'completion form', formShort: 'completion form' },
  delivery: { work: 'Home Depot delivery', form: 'proof-of-delivery form', formShort: 'proof-of-delivery form' },
}

export function renderEsignCustomerSms(stage: CustomerStage, service: TemplateService, opts: { greetingName: string | null; link: string }): string {
  const w = WORDS[service]
  const hi = opts.greetingName ? `Hi ${opts.greetingName}, ` : 'Hi, '
  if (stage === 'heads_up') {
    return `${hi}it's Castle Garage Doors. Your ${w.work} is scheduled soon. Home Depot requires a signed ${w.form} for the work — we're sending it now so you have it. Once your ${service === 'install' ? 'installation' : 'delivery'} is complete, please come back here to review and e-sign it: ${opts.link}. Reply STOP to opt out.`
  }
  if (stage === 'ask') {
    return `${hi}now that your ${w.work} is complete, Home Depot needs your e-signature on the ${w.form}. It takes about a minute: ${opts.link}`
  }
  return `Quick reminder from Castle Garage Doors — Home Depot's ${w.form} for your ${service === 'install' ? 'garage door installation' : 'order'} is still waiting for your e-signature: ${opts.link}`
}

export function renderEsignCustomerEmail(stage: CustomerStage, service: TemplateService, opts: { greetingName: string | null; link: string }): { subject: string; html: string; text: string } {
  const w = WORDS[service]
  const done = service === 'install' ? 'installation' : 'delivery'
  const hi = opts.greetingName ? `Hi ${opts.greetingName},` : 'Hi,'
  let subject: string, paras: string[], cta: string, under: string | null = null
  if (stage === 'heads_up') {
    subject = `Your Home Depot ${w.form} — for after your ${done}`
    paras = [
      `Your ${w.work} is scheduled soon. Home Depot requires a signed ${w.form} for the work — we're sending it now so you have it.`,
      `Once your ${done} is complete, please come back here to review and e-sign it.`,
    ]
    cta = `Review & e-sign after the ${done}`
    under = `Please wait until the ${done} is finished before signing.`
  } else if (stage === 'ask') {
    subject = `Your ${done} is complete — please e-sign the Home Depot ${w.form}`
    paras = [`Now that your ${w.work} is complete, Home Depot needs your e-signature on the ${w.form}. It takes about a minute.`]
    cta = 'Review & e-sign'
  } else {
    subject = `Reminder: Home Depot's ${w.form} is waiting for your e-signature`
    paras = [`Quick reminder from Castle Garage Doors — Home Depot's ${w.form} for your ${service === 'install' ? 'garage door installation' : 'order'} is still waiting for your e-signature.`]
    cta = 'Review & e-sign'
  }
  const text = `${hi}\n\n${paras.join('\n\n')}\n\n${cta}: ${opts.link}${under ? `\n\n${under}` : ''}\n\nQuestions? Call us at (800) 576-1397 or just reply to this email.\n\n— Castle Team`
  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link href="${FONTS}" rel="stylesheet"></head>
<body style="margin:0; background:#F5F5F3; padding:24px; font-family:${BODY}; color:#1A1A1A;">
  <div style="max-width:560px; margin:0 auto; background:#FFFFFF; border-radius:12px; overflow:hidden; border:1px solid #E2E0DC;">
    <div style="background:#FFFFFF; padding:24px 28px 18px; text-align:center; border-bottom:3px solid #C81E1E;">
      <img src="${LOGO_URL}" alt="Castle Garage Doors and Gates" style="width:260px; max-width:80%; height:auto;">
    </div>
    <div style="padding:28px;">
      <p style="font-size:16px; line-height:1.6; margin:0 0 16px;">${esc(hi)}</p>
      ${paras.map(p => `<p style="font-size:16px; line-height:1.6; margin:0 0 16px;">${esc(p)}</p>`).join('\n      ')}
      <div style="text-align:center; margin:24px 0;">
        <a href="${esc(opts.link)}" style="display:inline-block; background:#C81E1E; color:#FFFFFF; text-decoration:none; font-family:${DISPLAY}; font-weight:700; font-size:16px; padding:15px 44px; border-radius:8px;">${esc(cta)}</a>
        ${under ? `<div style="font-size:13px; color:#64646E; margin-top:8px;">${esc(under)}</div>` : ''}
        <div style="font-size:12px; color:#8A8A94; margin-top:8px; word-break:break-all;">${esc(opts.link)}</div>
      </div>
      <p style="font-size:16px; line-height:1.6; margin:0;">Questions? Call us at (800) 576-1397 or just reply to this email.</p>
    </div>
    <div style="background:#0F0F0F; padding:20px 28px;">
      <p style="font-family:${DISPLAY}; font-weight:700; font-size:13px; color:#FFFFFF; margin:0 0 4px; letter-spacing:0.3px;">Castle Team</p>
      <p style="font-size:12px; color:#8A8A94; margin:0; line-height:1.5;">Family-owned &amp; operated since 1981 &mdash; serving San Diego to Riverside County &middot; CSLB #1154002<br>(800) 576-1397 &middot; ${emailFooterDomain()}</p>
    </div>
  </div>
</body>
</html>`
  return { subject, html, text }
}

/** Technician: after the customer signs. */
export function renderEsignTechSms(service: TemplateService, opts: { customerName: string; address: string; jobNumber: string | null; link: string }): string {
  const w = WORDS[service]
  return `${opts.customerName} at ${opts.address} has signed the Home Depot ${w.formShort}${opts.jobNumber ? ` for job ${opts.jobNumber}` : ''}. Please add your signature: ${opts.link}`
}
export function renderEsignTechEmail(service: TemplateService, opts: { customerName: string; address: string; jobNumber: string | null; link: string }): { subject: string; html: string; text: string } {
  const body = renderEsignTechSms(service, opts)
  const subject = `Your signature needed — Home Depot ${WORDS[service].formShort}${opts.jobNumber ? ` (job ${opts.jobNumber})` : ''}`
  return { subject, text: body, html: `<p style="font-family:${BODY}; font-size:16px; line-height:1.6;">${esc(body.replace(opts.link, ''))}<a href="${esc(opts.link)}">${esc(opts.link)}</a></p>` }
}
