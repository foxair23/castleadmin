import { ownDomainsPattern } from '@/lib/config/domains'
import type { InboundEmail, EmailAddress } from './types'

// info@castlegarage.com is a Google Group. Mail a partner sends to it reaches Cassie's
// mailbox REWRITTEN by Google: From becomes "'DC St. Louis' via Info <info@castlegarage.com>",
// the real sender moves to Reply-To / X-Original-Sender, and list headers are added. Taken
// at face value that looks like a Castle person writing (and like bulk mail), so every
// partner question arriving through the group was recorded as "Castle staff wrote" and
// never answered. This puts the real sender back before anything else looks at the message.

const lower = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()
const domainOf = (addr: string) => lower(addr).split('@')[1] ?? ''

function parseOne(v: string | undefined): EmailAddress | null {
  if (!v) return null
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(v) || /^\s*([^\s<>]+@[^\s<>]+)\s*$/.exec(v)
  if (!m) return null
  return m.length === 3 ? { addr: m[2].trim().toLowerCase(), name: (m[1] ?? '').trim() || null } : { addr: m[1].trim().toLowerCase(), name: null }
}

/** Is this message a Google Group relay of someone else's mail? Returns the group address. */
export function groupRelayOf(email: InboundEmail): string | null {
  const from = lower(email.from.addr)
  if (!ownDomainsPattern.test(domainOf(from))) return null
  const h = email.headers
  const viaName = /\svia\s/i.test(email.from.name ?? '')
  const original = parseOne(h['x-original-sender']) ?? parseOne(h['x-original-from']) ?? parseOne(h['reply-to'])
  if (!original || lower(original.addr) === from) return null
  if (h['x-google-group-id'] !== undefined || h['x-original-sender'] !== undefined || (viaName && h['reply-to'])) return from
  return null
}

/** The message as the partner actually sent it: their address and name as From, the group
 *  noted in `relayedVia`. Untouched when it is not a relay. */
export function unwrapGroupRelay(email: InboundEmail): InboundEmail {
  const via = groupRelayOf(email)
  if (!via) return email
  const h = email.headers
  const original = parseOne(h['x-original-from']) ?? parseOne(h['x-original-sender']) ?? parseOne(h['reply-to'])!
  const stripped = (email.from.name ?? '').replace(/\s+via\s+.*$/i, '').replace(/^['"\s]+|['"\s]+$/g, '').trim()
  const name = original.name ?? (stripped || null)
  return { ...email, from: { addr: original.addr, name }, relayedVia: via }
}
