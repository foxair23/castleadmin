import { ownDomainsPattern } from '@/lib/config/domains'
import { isAllowlisted, type AgentSettings } from '@/lib/agent/settings'
import type { InboundEmail, ThreadState, FilterResult } from './types'

// Hard filters — deterministic, before any model call (PRD §5 Stage 2). Anything
// that fails here gets no reply, no draft, no model call: it stays in info@ for a
// person exactly as today. Order matters: the cheapest, most decisive checks run
// first, and "a Castle person already wrote" is checked last so that outcome is
// recorded even for senders who would otherwise be dropped.

// Whole tokens of the local part, split on . _ - so "orders-notifications" matches and
// "annotifications" (a person) does not.
const NOREPLY_LOCAL = /(^|[._-])(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?|alerts?|auto-?mailer|system|automated)([._-]|$)/i
const AUTO_SUBJECT = /^\s*((auto(matic)?[ -]?(reply|response))|out[ -]of[ -](the[ -])?office|away from (my|the) (desk|office)|delivery (status )?(notification|failure)|undeliverable)/i

const lower = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()
const domainOf = (addr: string) => lower(addr).split('@')[1] ?? ''

/** RFC 3834 / vendor headers that mark machine-generated mail. */
export function isAutoReply(headers: Record<string, string>, subject: string): string | null {
  const h = (k: string) => lower(headers[k])
  const autoSubmitted = h('auto-submitted')
  if (autoSubmitted && autoSubmitted !== 'no') return `Auto-Submitted: ${autoSubmitted}`
  if (headers['x-autoreply'] !== undefined || headers['x-autorespond'] !== undefined) return 'X-Autoreply header'
  if (h('x-auto-response-suppress')) return 'X-Auto-Response-Suppress header'
  if (/^(auto[_-]?reply|auto[_-]?generated)$/i.test(h('x-mailer-type'))) return 'auto-generated mailer'
  const prec = h('precedence')
  if (/^(auto[_-]?reply)$/.test(prec)) return `Precedence: ${prec}`
  if (AUTO_SUBJECT.test(subject)) return `subject "${subject.slice(0, 60)}"`
  return null
}

/** Newsletters, list mail, notification blasts. */
export function isBulk(headers: Record<string, string>): string | null {
  const prec = lower(headers['precedence'])
  if (/^(bulk|junk|list)$/.test(prec)) return `Precedence: ${prec}`
  if (headers['list-id'] !== undefined || headers['list-unsubscribe'] !== undefined) return 'mailing-list headers'
  return null
}

export function isNoReplySender(addr: string): boolean {
  const local = lower(addr).split('@')[0] ?? ''
  return NOREPLY_LOCAL.test(local)
}

/** Did the sender write to Cassie's address directly, or did it come via the group? */
export function deliveryPath(email: InboundEmail, settings: AgentSettings): 'direct' | 'distribution' {
  const me = lower(settings.mailbox_address)
  const direct = [...email.to, ...email.cc].some(a => lower(a.addr) === me)
  return direct ? 'direct' : 'distribution'
}

/** Body without quoted history, for the emptiness check and later for the composer. */
export function stripQuotedHistory(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  for (const raw of lines) {
    const line = raw.trimEnd()
    // "On Mon, Sep 7, 2026 at 9:12 AM Jane <jane@x.com> wrote:" — and Outlook's
    // "-----Original Message-----" / "From: ... Sent: ..." blocks — start the history.
    if (/^On .{5,120} wrote:\s*$/.test(line)) break
    if (/^-{2,}\s*(Original|Forwarded) Message\s*-{2,}$/i.test(line)) break
    if (/^_{10,}$/.test(line)) break
    if (/^From:\s.+/.test(line) && lines.some(l => /^Sent:\s|^Date:\s/.test(l))) break
    if (line.startsWith('>')) continue
    out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function applyHardFilters(email: InboundEmail, settings: AgentSettings, thread: ThreadState): FilterResult {
  const from = lower(email.from.addr)

  if (!settings.processing_enabled) return { pass: false, reason: 'processing_off', detail: 'Processing switch is off' }

  // Loop protection first — our own mail must never be treated as an inquiry.
  if (from === lower(settings.mailbox_address)) return { pass: false, reason: 'own_address', detail: 'sent by Cassie' }

  // A Castle person writing in the thread is not an inquiry; it is the signal that a
  // human has this thread. Recorded, never drafted.
  if (ownDomainsPattern.test(domainOf(from))) return { pass: false, reason: 'human_reply', detail: `from Castle address ${from}` }

  if (settings.blocklist_addresses.some(b => lower(b) === from)) return { pass: false, reason: 'blocklisted', detail: from }
  if (!isAllowlisted(settings, from)) return { pass: false, reason: 'not_allowlisted', detail: domainOf(from) || from }
  if (isNoReplySender(from)) return { pass: false, reason: 'noreply_sender', detail: from }

  const auto = isAutoReply(email.headers, email.subject)
  if (auto) return { pass: false, reason: 'auto_reply', detail: auto }
  const bulk = isBulk(email.headers)
  if (bulk) return { pass: false, reason: 'bulk_mail', detail: bulk }

  if (!stripQuotedHistory(email.bodyText)) return { pass: false, reason: 'empty_body', detail: 'nothing but quoted history or empty' }

  // Thread discipline: one Cassie reply per thread (PRD §6.3). A partner's follow-up
  // on an actioned thread is handled by outcome monitoring, not by another draft.
  if (thread.agentReplied) return { pass: false, reason: 'thread_actioned', detail: 'Cassie already replied in this thread' }
  if (thread.humanRepliedAfterInquiry) return { pass: false, reason: 'human_replied', detail: 'a Castle team member already replied' }

  return { pass: true, deliveryPath: deliveryPath(email, settings) }
}
