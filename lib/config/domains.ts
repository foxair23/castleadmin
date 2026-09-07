// Every domain, origin and mailbox the app refers to, in one place.
//
// The company moved from castlegaragedoors.com to castlegarage.com after the old domain was
// sold. Before this module, the old domain was hardcoded in ~30 places across routes, email
// templates, the proxy and the extension — and, more dangerously, several of those were
// addresses we SEND to (compliance BCCs, the office CC on DC requests, customer reply-to).
// Whoever owns the old domain now receives anything still pointed there.
//
// Rules:
//   • Anything we send TO defaults to the NEW domain. A bounce to a mailbox that does not
//     exist yet is visible and harmless; a delivery to the buyer is neither.
//   • Anything we send FROM defaults to the OLD domain until EMAIL_FROM is set, because an
//     unverified Resend sender fails every outbound email. Flip it only once Resend shows the
//     new domain as Verified.
//   • Self-links follow NEXT_PUBLIC_APP_URL, with castleadmin.vercel.app as the fallback that
//     always works.
//   • Inbound (CORS) accepts old AND new scheduler origins during the transition.

const strip = (s: string) => s.replace(/\/+$/, '')

/** The admin app's own origin — used for every self-referencing link we generate. */
export const appUrl = (): string =>
  strip(process.env.NEXT_PUBLIC_APP_URL || 'https://castleadmin.vercel.app')

/** The public marketing site (legal/terms pages, the bare short-link redirect). */
export const marketingUrl = (): string =>
  strip(process.env.MARKETING_URL || 'https://castlegarage.com')

/** Outbound sender. Keep on the OLD verified domain until Resend verifies the new one. */
export const emailFrom = (): string =>
  process.env.EMAIL_FROM || 'Castle Garage Doors <noreply@updates.castlegaragedoors.com>'

/** The monitored office inbox — customer reply-to, DC request CC. */
export const officeEmail = (): string =>
  process.env.OFFICE_EMAIL || 'info@castlegarage.com'

/** Record-keeping copy of approvals and commission acceptances. */
export const complianceBcc = (): string =>
  process.env.COMPLIANCE_BCC || officeEmail()

/** Where the Clopay DC replies with STS detail; must route to our inbound webhook. */
export const clopayStsInboundAddress = (): string =>
  process.env.CLOPAY_STS_INBOUND_ADDRESS || 'clopay-sts@updates.castlegarage.com'

/** Origins allowed to call the public scheduler APIs. Old + new during the move, plus the
 *  GitHub Pages host the Genie scheduler is served from. Comma-separated override. */
export const schedulerOrigins = (): string[] => {
  const env = (process.env.SCHEDULER_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
  const defaults = ['https://schedule.castlegarage.com', 'https://schedule.castlegaragedoors.com']
  return [...new Set([...(env.length ? env : defaults), 'https://foxair23.github.io'])]
}

/** Sender domains that are OURS, so the lead parser never treats our own mail as a lead. */
export const ownDomainsPattern = /(castlegarage\.com|castlegaragedoors\.com)/i

/** Logo for email templates. Served from our own origin — the old marketing host is no
 *  longer ours, and an email logo someone else controls is not acceptable. */
export const emailLogoUrl = (): string => `${appUrl()}/email/logo.png`

/** Footer line for customer emails. */
export const emailFooterDomain = (): string => marketingUrl().replace(/^https?:\/\//, '')
