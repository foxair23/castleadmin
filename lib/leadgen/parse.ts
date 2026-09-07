// Parse inbound provider "new lead" emails into structured fields.
//
// Providers are pluggable: `parseLead()` sniffs which provider an email is from
// and dispatches to that provider's parser. Home Depot is the only one today.
// The forwarded email keeps the original body, which is a simple "Label: value"
// layout, so we extract each field by its label.

// 'home_depot' today; the AI fallback can emit other provider slugs for new sources.
export type LeadProvider = string

export interface ParsedLead {
  provider: LeadProvider
  externalId: string | null
  customerName: string | null
  phoneRaw: string | null
  email: string | null
  addressStreet: string | null
  addressCity: string | null
  addressState: string | null
  addressPostal: string | null
  programName: string | null
  source: string | null
  referralStore: string | null
  notes: string | null
}

export interface RawInboundEmail {
  from: string | null
  subject: string | null
  text: string | null
  html: string | null
}

/** Very small HTML→text: drop tags, decode a few entities, collapse blank runs. */
function htmlToText(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/div|\/tr|\/h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
}

/** Normalize the email body to plain text and strip forward quote markers. */
export function emailToText(email: RawInboundEmail): string {
  const base = (email.text && email.text.trim()) ? email.text : (email.html ? htmlToText(email.html) : '')
  return base
    .split('\n')
    .map(line => line.replace(/^\s*>+\s?/, '').replace(/\*/g, '').replace(/ /g, ' ').trimEnd())
    .join('\n')
}

// Footer boilerplate that trails the last field (Notes) in the HD email.
const FOOTER_RE = /\n?\s*(Thanks,|This is an automated|Home Services|The Home Depot|Paces Ferry|©|Copyright)/i

function stripFooter(v: string | null): string | null {
  if (!v) return null
  const m = FOOTER_RE.exec(v)
  const out = (m ? v.slice(0, m.index) : v).trim()
  return out || null
}

// Labels the HD email uses, in the order they appear. Used both to find a
// field's value and to know where that value ends (the next label).
const HD_LABELS = [
  'Name', 'Phone', 'Email Address', 'Email', 'Address',
  'Appointment Preferences', 'Service Center ID', 'Referral Store',
  'Referral Associate', 'Source', 'Program Name', 'Job Type', 'Notes',
]

/**
 * Grab the value that follows `label:` — on the same line or the next non-empty
 * line(s) — stopping at the next known label. Returns null if not present/empty.
 */
function fieldAfter(text: string, label: string, stopLabels: string[]): string | null {
  const re = new RegExp(`(^|\\n)\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*`, 'i')
  const m = re.exec(text)
  if (!m) return null
  const start = m.index + m[0].length
  const rest = text.slice(start)
  const stopRe = new RegExp(`\\n\\s*(?:${stopLabels.map(l => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*:`, 'i')
  const stop = stopRe.exec(rest)
  const chunk = (stop ? rest.slice(0, stop.index) : rest).trim()
  // Collapse internal whitespace/newlines to single spaces for single-line fields;
  // callers that want multi-line (address) re-split on the raw chunk.
  const cleaned = chunk.replace(/[ \t]*\n[ \t]*/g, '\n').trim()
  return cleaned || null
}

function firstEmailIn(text: string): string | null {
  // Skip our own / the provider's addresses; take the first customer-looking one.
  const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []
  // Our own domains (old and new — old mail still arrives during the move) plus the usual
  // no-reply senders are never treated as a lead contact.
  const skip = /(castlegarage\.com|castlegaragedoors|homedepot|home-?services|no-?reply|donotreply)/i
  for (const e of matches) if (!skip.test(e)) return e.toLowerCase()
  return null
}

function isHomeDepot(email: RawInboundEmail, text: string): boolean {
  const hay = `${email.from ?? ''} ${email.subject ?? ''} ${text}`
  return /home\s*depot/i.test(hay) || /home\s*services/i.test(hay)
}

function parseHomeDepot(text: string): ParsedLead {
  const name = fieldAfter(text, 'Name', HD_LABELS)
  const phone = fieldAfter(text, 'Phone', HD_LABELS)
  let email = fieldAfter(text, 'Email Address', HD_LABELS) ?? fieldAfter(text, 'Email', HD_LABELS)
  if (email) { const e = email.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i); email = e ? e[0].toLowerCase() : null }
  if (!email) email = firstEmailIn(text)

  const addressBlock = fieldAfter(text, 'Address', HD_LABELS)
  let street: string | null = null, city: string | null = null, state: string | null = null, postal: string | null = null
  if (addressBlock) {
    const lines = addressBlock.split('\n').map(l => l.trim()).filter(Boolean)
    // Last line usually "City, ST 92129"; earlier line(s) the street.
    const cityLine = lines.find(l => /,\s*[A-Z]{2}\s+\d{5}/.test(l)) ?? lines[lines.length - 1] ?? ''
    const cm = /^(.*?),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?/.exec(cityLine)
    if (cm) { city = cm[1].trim() || null; state = cm[2]; postal = cm[3] }
    const streetLines = lines.filter(l => l !== cityLine)
    street = streetLines.length ? streetLines.join(', ') : (cm ? null : cityLine || null)
  }

  return {
    provider: 'home_depot',
    externalId: fieldAfter(text, 'Service Center ID', HD_LABELS),
    customerName: name,
    phoneRaw: phone,
    email,
    addressStreet: street,
    addressCity: city,
    addressState: state,
    addressPostal: postal,
    programName: fieldAfter(text, 'Program Name', HD_LABELS),
    source: fieldAfter(text, 'Source', HD_LABELS),
    referralStore: fieldAfter(text, 'Referral Store', HD_LABELS),
    notes: stripFooter(fieldAfter(text, 'Notes', HD_LABELS)),
  }
}

/**
 * Parse an inbound email into a lead, or null if it isn't a recognized provider
 * lead / has no usable contact info.
 */
export function parseLead(email: RawInboundEmail): { parsed: ParsedLead; text: string } | null {
  const text = emailToText(email)
  if (!text.trim()) return null
  if (!isHomeDepot(email, text)) return null
  const parsed = parseHomeDepot(text)
  // Need at least a name and one way to reach them.
  if (!parsed.customerName && !parsed.phoneRaw && !parsed.email) return null
  return { parsed, text }
}
