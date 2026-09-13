import type { ReplyBand } from './settings'

// Hard rules for review replies (PRD §4.2 step 5), enforced in code before any
// human or autopilot sees a draft. The charter says the same things in words;
// this is the part that cannot be talked around. Pure and unit-tested.

export type GuardrailCheck =
  | 'tech_name' | 'customer_last_name' | 'address' | 'price' | 'warranty' | 'arguing'
  | 'length' | 'service_type' | 'city' | 'signature'

export interface GuardrailFailure { check: GuardrailCheck; detail: string }
export interface GuardrailResult { passed: boolean; failures: GuardrailFailure[]; wordCount: number }

export interface GuardrailContext {
  band: ReplyBand
  hasJob: boolean
  /** Technician and office staff names (full strings). */
  roster: string[]
  reviewerName: string | null
  customerName: string | null
  contactLastName: string | null
  street: string | null
  /** Phrases that count as "the service was named"; empty = check skipped. */
  serviceTerms: string[]
  city: string | null
  neighborhood?: string | null
  signature: string
  /** Names the reviewer wrote (ai_mentioned_names); the reply must not echo them. */
  mentionedNames: string[]
}

export const LENGTH_BANDS: Record<'positive' | 'negative' | 'positiveNoJob' | 'negativeNoJob', [number, number]> = {
  positive: [40, 120], negative: [60, 150], positiveNoJob: [25, 120], negativeNoJob: [40, 150],
}

/** Common words that are also names; never treated as a name token on their own. */
export const NAME_STOPLIST: ReadonlySet<string> = new Set([
  'will', 'may', 'bill', 'mark', 'guy', 'grant', 'ray', 'pat', 'art', 'rich', 'chase', 'hope', 'joy', 'faith',
  'summer', 'dawn', 'miles', 'don', 'max', 'gene', 'king', 'lane', 'wade', 'cliff', 'rock', 'castle', 'garage',
  'door', 'gate', 'team', 'tech', 'jr', 'sr', 'the', 'and', 'van', 'von', 'del', 'de', 'la', 'le',
])

export const WARRANTY_TERMS = ['warranty', 'guarantee', 'guaranteed', 'refund', 'free of charge', 'no charge', 'at no cost', 'we will cover', "we'll cover", 'lifetime', 'discount', 'credit toward']
export const ARGUING_TERMS = ["that's not true", 'that is not true', 'not accurate', 'inaccurate', 'never happened', 'you are wrong', "you're wrong", 'false', 'lying', 'liar', 'dispute', 'you failed', 'your fault']

const STREET_STOP = new Set(['st', 'street', 'ave', 'avenue', 'rd', 'road', 'dr', 'drive', 'ln', 'lane', 'blvd', 'boulevard', 'way', 'ct', 'court', 'pl', 'place', 'cir', 'circle', 'ter', 'terrace', 'hwy', 'highway', 'north', 'south', 'east', 'west', 'apt', 'unit', 'suite', 'ste'])
const ADDRESS_RE = /\b\d{2,6}\s+[A-Za-z][A-Za-z']*(?:\s+[A-Za-z][A-Za-z']*){0,2}\s+(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|way|ct|court|pl|place|cir|circle|ter|terrace)\b\.?/i
const GENERIC_ITEMS = new Set(['labor', 'misc', 'other', 'parts', 'trip charge', 'service call', 'travel', 'tax', 'fee', 'deposit'])
const PRICE_RE = /\$\s?\d|\b\d+(?:\.\d+)?\s?(dollars|bucks)\b/i

export const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const hasWord = (body: string, term: string) => new RegExp(`(^|[^A-Za-z])${esc(term)}(?=$|[^A-Za-z])`, 'i').test(body)

/** Tokens that may not appear in a reply: every first, last and full name from the roster and the reviewer's mentions. */
export function forbiddenNameTokens(roster: string[], extra: string[] = []): string[] {
  const out = new Set<string>()
  for (const name of [...roster, ...extra]) {
    const clean = (name ?? '').replace(/[^A-Za-z' -]/g, ' ').trim()
    if (!clean) continue
    const parts = clean.split(/\s+/).filter(Boolean)
    if (parts.length > 1) out.add(clean.toLowerCase())
    for (const p of parts) {
      const t = p.toLowerCase().replace(/^'+|'+$/g, '')
      if (t.length >= 3 && !NAME_STOPLIST.has(t)) out.add(t)
    }
  }
  return [...out]
}

function surnameOf(name: string | null): string | null {
  if (!name) return null
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length < 2) return null
  const last = parts[parts.length - 1].replace(/[^A-Za-z'-]/g, '')
  // "Mike T." style initials are not a surname.
  if (last.length < 3 || /\.$/.test(parts[parts.length - 1])) return null
  return last.toLowerCase()
}

/** Phrases that count as naming the service, from the job category and line items. */
export function serviceTermsFor(category: string | null, itemNames: string[] = []): string[] {
  const out = new Set<string>()
  const cat = (category ?? '').toLowerCase()
  const rules: Array<[RegExp, string[]]> = [
    [/garage\s*door/, ['garage door', 'door']],
    [/opener/, ['opener']],
    [/gate/, ['gate']],
    [/spring/, ['spring']],
    [/install|new door|replacement/, ['install', 'installation', 'new door', 'new gate', 'replacement']],
    [/repair|service call|service/, ['repair', 'service']],
    [/maint|tune/, ['maintenance', 'tune-up', 'tune up', 'service']],
    [/commercial/, ['commercial']],
  ]
  for (const [re, terms] of rules) if (re.test(cat)) terms.forEach(t => out.add(t))
  for (const item of itemNames) {
    const name = (item ?? '').toLowerCase().replace(/[^a-z0-9 -]/g, ' ').replace(/\s+/g, ' ').trim()
    if (!name) continue
    if (GENERIC_ITEMS.has(name)) continue
    if (name.length >= 4 && name.length <= 40) out.add(name)
    for (const w of name.split(' ')) if (w.length >= 5 && !GENERIC_ITEMS.has(w)) out.add(w)
  }
  if (out.size === 0 && cat) for (const w of cat.split(/[^a-z]+/)) if (w.length >= 4) out.add(w)
  return [...out]
}

export function checkReplyGuardrails(body: string, ctx: GuardrailContext): GuardrailResult {
  const failures: GuardrailFailure[] = []
  const text = body ?? ''
  const lower = text.toLowerCase()

  // Tech / staff names, and names the reviewer used, except the reviewer's own first name.
  const reviewerFirst = ctx.reviewerName?.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z'-]/g, '') ?? ''
  for (const tok of forbiddenNameTokens(ctx.roster, ctx.mentionedNames)) {
    if (tok === reviewerFirst) continue
    if (hasWord(text, tok)) { failures.push({ check: 'tech_name', detail: `names "${tok}"` }); break }
  }

  // Customer surname (from the job or the reviewer's own display name).
  const surnames = new Set<string>()
  for (const s of [surnameOf(ctx.customerName), surnameOf(ctx.reviewerName), ctx.contactLastName?.trim().toLowerCase() ?? null]) {
    if (s && s.length >= 3 && !NAME_STOPLIST.has(s)) surnames.add(s)
  }
  for (const s of surnames) if (hasWord(text, s)) { failures.push({ check: 'customer_last_name', detail: `mentions "${s}"` }); break }

  // Street address.
  if (ADDRESS_RE.test(text)) failures.push({ check: 'address', detail: 'contains a street address' })
  else if (ctx.street) {
    const toks = ctx.street.toLowerCase().split(/[^a-z']+/).filter(t => t.length >= 4 && !STREET_STOP.has(t))
    const hit = toks.find(t => hasWord(text, t))
    if (hit) failures.push({ check: 'address', detail: `mentions the street ("${hit}")` })
  }

  if (PRICE_RE.test(text)) failures.push({ check: 'price', detail: 'mentions a price' })
  const w = WARRANTY_TERMS.find(t => lower.includes(t))
  if (w) failures.push({ check: 'warranty', detail: `promises or discusses "${w}"` })
  if (ctx.band === 'negative') {
    const a = ARGUING_TERMS.find(t => lower.includes(t))
    if (a) failures.push({ check: 'arguing', detail: `argues with the reviewer ("${a}")` })
  }

  const wc = wordCount(text)
  const band = ctx.band === 'positive' ? (ctx.hasJob ? LENGTH_BANDS.positive : LENGTH_BANDS.positiveNoJob) : (ctx.hasJob ? LENGTH_BANDS.negative : LENGTH_BANDS.negativeNoJob)
  if (wc < band[0] || wc > band[1]) failures.push({ check: 'length', detail: `${wc} words; needs ${band[0]}–${band[1]}` })

  if (ctx.serviceTerms.length && !ctx.serviceTerms.some(t => lower.includes(t.toLowerCase()))) {
    failures.push({ check: 'service_type', detail: `does not name the service (${ctx.serviceTerms.slice(0, 3).join(', ')})` })
  }
  if (ctx.city) {
    const places = [ctx.city, ctx.neighborhood ?? ''].filter(Boolean).map(p => p.toLowerCase())
    if (!places.some(p => lower.includes(p))) failures.push({ check: 'city', detail: `does not mention ${ctx.city}` })
  }

  if (ctx.signature && lower.includes(ctx.signature.toLowerCase())) failures.push({ check: 'signature', detail: 'includes the signature (it is added automatically)' })
  else if (/^\s*[-–—]\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s*$/m.test(text)) failures.push({ check: 'signature', detail: 'signs off with a name' })

  return { passed: failures.length === 0, failures, wordCount: wc }
}

/** Replace roster names inside job notes so the drafter never sees them. */
export function scrubNames(text: string | null | undefined, roster: string[]): string | null {
  if (!text) return null
  let out = text
  for (const tok of forbiddenNameTokens(roster).sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(^|[^A-Za-z])${esc(tok)}(?=$|[^A-Za-z])`, 'gi'), '$1our technician')
  }
  return out.replace(/(our technician\s*){2,}/gi, 'our technician ').replace(/\s{2,}/g, ' ').trim()
}
