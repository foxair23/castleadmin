// Who a signing token belongs to and what the page may do with it. Pure, so the state
// machine is testable without a database; the page and the API both go through here.

export type SignScope = 'customer' | 'tech'
export type SignState = 'ready' | 'already_signed' | 'waiting_customer' | 'not_ready' | 'cancelled'

export interface SignDoc {
  status: string
  customer_token: string
  tech_token: string
  customer_signed_at: string | null
  tech_signed_at: string | null
}

export function scopeForToken(doc: SignDoc, token: string): SignScope | null {
  if (token && doc.customer_token === token) return 'customer'
  if (token && doc.tech_token === token) return 'tech'
  return null
}

/** Statuses from which each party may sign. The customer signs first; the link is never
 *  locked by date (the message wording carries "after the work is done"). */
const CUSTOMER_MAY_SIGN = ['prepared', 'sent_customer']
const TECH_MAY_SIGN = ['customer_signed', 'sent_tech']

export function signState(doc: SignDoc, scope: SignScope): SignState {
  if (doc.status === 'cancelled') return 'cancelled'
  if (scope === 'customer') {
    if (doc.customer_signed_at) return 'already_signed'
    return CUSTOMER_MAY_SIGN.includes(doc.status) ? 'ready' : 'not_ready'
  }
  if (doc.tech_signed_at) return 'already_signed'
  if (TECH_MAY_SIGN.includes(doc.status)) return 'ready'
  if (CUSTOMER_MAY_SIGN.includes(doc.status) || doc.status === 'found' || doc.status === 'unrecognised_template') return 'waiting_customer'
  return 'not_ready'
}

/** The status a successful signature moves the document to, or null when it may not sign.
 *  The API applies it as a conditional update on the CURRENT status, so two submits of one
 *  link cannot both land. */
export function statusAfterSign(scope: SignScope, current: string): string | null {
  if (scope === 'customer') return CUSTOMER_MAY_SIGN.includes(current) ? 'customer_signed' : null
  return TECH_MAY_SIGN.includes(current) ? 'tech_signed' : null
}

/** PNG sanity: magic bytes and a size ceiling. The pad exports at most a few hundred KB. */
export const MAX_SIG_BYTES = 1_000_000
export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
}
export function decodeDataUrlPng(dataUrl: string): Uint8Array | null {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim())
  if (!m) return null
  if (m[1].length > MAX_SIG_BYTES * 1.4) return null
  const bytes = Uint8Array.from(Buffer.from(m[1], 'base64'))
  return isPng(bytes) && bytes.length <= MAX_SIG_BYTES ? bytes : null
}
