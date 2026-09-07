import { normPhone } from '@/lib/matching/sf-job-match'
import type { ResolverIdentifiers } from '@/lib/agent/job-resolver'

// Deterministic identifier extraction from an inquiry. This runs BEFORE the model
// and its output is what the resolver trusts; the classifier (chunk 6) may add a
// customer name it reads from prose, but PO numbers found here are authoritative.
//
// Home Depot POs are 8–11 digit numbers; Clopay order numbers are 10 digits; SF job
// numbers are 10 digits too, which is fine — the resolver checks both fields.

const PO_LABELLED = /\b(?:p\.?o\.?|po#|po\s*#|purchase\s*order|order(?:\s*(?:no|number|#))?|job(?:\s*(?:no|number|#))?|ref(?:erence)?)\s*[:#]?\s*([A-Z]{0,3}[-\s]?\d{6,12})\b/gi
const PO_BARE = /\b(\d{8,11})\b/g
const PHONE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi

export interface ExtractedIdentifiers extends ResolverIdentifiers {
  pos: string[]
  /** Phone numbers found in the body, normalised to 10 digits. */
  phones: string[]
  /** Emails found in the body other than the sender's and our own. */
  emails: string[]
}

export function extractIdentifiers(bodyText: string, opts: { excludeEmails?: string[] } = {}): ExtractedIdentifiers {
  const text = bodyText ?? ''
  const pos = new Set<string>()
  for (const m of text.matchAll(PO_LABELLED)) pos.add(m[1].replace(/[\s-]/g, '').toUpperCase())
  for (const m of text.matchAll(PO_BARE)) {
    // A bare long number is a PO unless it is clearly a phone number.
    const digits = m[1]
    if (digits.length === 10 && looksLikePhoneContext(text, m.index ?? 0)) continue
    pos.add(digits)
  }

  const phones = new Set<string>()
  for (const m of text.matchAll(PHONE)) {
    const p = normPhone(m[0])
    if (p.length === 10 && !/^\d{10}$/.test(m[0].trim())) phones.add(p)   // formatted → phone; bare 10 digits stay a PO
  }
  // A bare 10-digit run that we kept as a PO should not also be a phone.
  for (const p of phones) pos.delete(p)

  const exclude = new Set((opts.excludeEmails ?? []).map(e => e.toLowerCase()))
  const emails = new Set<string>()
  for (const m of text.matchAll(EMAIL)) {
    const e = m[0].toLowerCase()
    if (!exclude.has(e)) emails.add(e)
  }

  return {
    pos: [...pos],
    phones: [...phones],
    emails: [...emails],
    email: [...emails][0] ?? null,
    phone: [...phones][0] ?? null,
    customerName: null,
  }
}

function looksLikePhoneContext(text: string, idx: number): boolean {
  const before = text.slice(Math.max(0, idx - 25), idx).toLowerCase()
  return /(phone|cell|mobile|tel|call|contact|reach)\W*$/.test(before)
}
