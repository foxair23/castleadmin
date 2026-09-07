import type { Fact } from './grounding'

// The enforcement behind "never fabricate a fact" (PRD §3.2, §7.3). The composer
// returns sentences with the fact ids each relies on. This module then checks, in
// code, that every concrete value in a sentence — a date, weekday, time, dollar
// amount, or capitalised name — appears in one of the facts it cited. Anything that
// fails is an UNSOURCED CLAIM: listed separately, shown in red, and a hard block on
// auto-send. The model's own opinion of its grounding is never consulted.

export interface ComposedClaim {
  text: string
  factIds: string[]
}

export interface CheckedClaim extends ComposedClaim {
  grounded: boolean
  /** The concrete values that no cited fact supports. */
  unsupported: string[]
}

export interface GroundingReport {
  claims: CheckedClaim[]
  unsourced: string[]
  /** Every claim is grounded and at least one concrete fact was used. */
  fullyGrounded: boolean
}

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec'
const DAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday'
const DATE_RE = new RegExp(`\\b(?:(?:${DAYS}),?\\s+)?(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b|\\b\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?\\b`, 'gi')
const DAY_RE = new RegExp(`\\b(?:${DAYS})\\b`, 'gi')
const TIME_RE = /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/gi
const MONEY_RE = /\$\s?\d[\d,]*(?:\.\d{2})?/g
const LONG_NUM_RE = /\b\d{6,}\b/g
// Two+ capitalised words in a row → likely a person/company name (sentence starts included:
// an invented technician name at the start of a sentence is exactly what must be caught).
const NAME_RE = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g

// Phrases that look like names but are ordinary in this domain / in English.
const NAME_STOPLIST = new Set(['Castle Garage', 'Home Depot', 'Service Fusion', 'Garage Doors', 'Castle Garage Doors', 'Castle Garage Doors Gates', 'Distribution Center', 'Thank You', 'Best Regards', 'Kind Regards', 'Store Manager', 'Purchase Order'])
// A run whose first word is an ordinary sentence opener is prose, not a name ("If Mark", "Our Luis").
const OPENERS = new Set(['The', 'We', 'Our', 'Please', 'Let', 'If', 'Your', 'This', 'That', 'It', 'I', 'You', 'He', 'She', 'They', 'Once', 'When', 'As', 'For', 'On', 'At', 'In', 'To', 'And', 'But', 'So', 'No', 'Yes', 'Not', 'Also', 'Here', 'There', 'Hi', 'Hello', 'Thanks', 'Thank'])

const norm = (s: string) => s.toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/[.,]/g, '').replace(/\s+/g, ' ').trim()

/** Extract every concrete value in a sentence that a fact must back. */
export function concreteValues(text: string): string[] {
  const out = new Set<string>()
  for (const re of [DATE_RE, TIME_RE, MONEY_RE, LONG_NUM_RE]) for (const m of text.matchAll(re)) out.add(m[0].trim())
  // Weekdays alone count only when not already inside a matched date.
  const dates = [...text.matchAll(DATE_RE)].map(m => m[0].toLowerCase())
  for (const m of text.matchAll(DAY_RE)) if (!dates.some(d => d.includes(m[0].toLowerCase()))) out.add(m[0])
  for (const m of text.matchAll(NAME_RE)) {
    const words = m[1].split(/\s+/)
    while (words.length > 1 && OPENERS.has(words[0])) words.shift()
    const name = words.join(' ')
    if (words.length >= 2 && !NAME_STOPLIST.has(name)) out.add(name)
  }
  return [...out]
}

/** Does any cited fact contain this value (loosely: case/punctuation-insensitive, ordinal-insensitive)? */
function supported(value: string, facts: Fact[]): boolean {
  const v = norm(value)
  if (!v) return true
  const vDigits = v.replace(/\D/g, '')
  for (const f of facts) {
    const hay = norm([f.text, ...f.values].join(' | '))
    if (hay.includes(v)) return true
    // "September 8" vs "Tuesday, September 8": token subset match for dates/names.
    const toks = v.split(' ')
    if (toks.length > 1 && toks.every(t => hay.includes(t))) return true
    // Times: "8:00 AM" vs "8:00 am" handled by norm; "8 AM" vs "8:00 AM":
    if (/^\d{1,2} ?(am|pm)$/.test(v)) { const [h, ap] = v.replace(/ /g, '').match(/^(\d{1,2})(am|pm)$/)!.slice(1); if (hay.includes(`${h}:00 ${ap}`)) return true }
    // Long numbers (POs) compare digit-only.
    if (vDigits.length >= 6 && hay.replace(/\D/g, '').includes(vDigits)) return true
  }
  return false
}

export function checkGrounding(claims: ComposedClaim[], facts: Fact[]): GroundingReport {
  const byId = new Map(facts.map(f => [f.id, f]))
  const checked: CheckedClaim[] = claims.map(c => {
    const cited = c.factIds.map(id => byId.get(id)).filter((f): f is Fact => !!f)
    const values = concreteValues(c.text)
    // A sentence with no concrete values (a greeting, "let me know") needs no citation.
    if (values.length === 0) return { ...c, grounded: true, unsupported: [] }
    // Concrete values but no valid citation → everything is unsupported.
    if (cited.length === 0) return { ...c, grounded: false, unsupported: values }
    const unsupported = values.filter(v => !supported(v, cited))
    return { ...c, grounded: unsupported.length === 0, unsupported }
  })
  const unsourced = checked.flatMap(c => c.unsupported.map(v => `"${v}" in: ${c.text}`))
  const usedFacts = checked.some(c => c.grounded && c.factIds.length > 0 && concreteValues(c.text).length > 0)
  return { claims: checked, unsourced, fullyGrounded: unsourced.length === 0 && usedFacts }
}
