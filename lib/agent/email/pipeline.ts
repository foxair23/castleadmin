import type { SupabaseClient } from '@supabase/supabase-js'
import { loadAgentSettings, type AgentSettings } from '@/lib/agent/settings'
import { applyHardFilters, stripQuotedHistory } from './filters'
import { extractIdentifiers } from './identifiers'
import type { InboundEmail, ThreadState } from './types'

// The processing pipeline entry point (PRD §5). One call per inbound message:
//   log it → hard filters → (accepted) hand to the composer stage.
// Every message is logged with an outcome, including drops. Idempotent on the Gmail
// message id so a re-poll never double-processes. The composer stage is injected
// (chunk 6) so this module stays testable and the replay path can run it too.

export interface AcceptedMessage {
  messageId: string
  email: InboundEmail
  cleanBody: string
  identifiers: ReturnType<typeof extractIdentifiers>
  deliveryPath: 'direct' | 'distribution'
  thread: ThreadState
}

export type ComposerStage = (db: SupabaseClient, settings: AgentSettings, accepted: AcceptedMessage) => Promise<{ outcome: string; detail?: string }>
/** Stage 8: a partner wrote again in a thread Cassie already answered (PRD §10). */
export type PartnerReplyStage = (db: SupabaseClient, settings: AgentSettings, input: { messageId: string; email: InboundEmail; cleanBody: string }) => Promise<{ outcome: string; detail?: string }>

export interface IngestResult {
  messageId: string | null
  outcome: string
  detail?: string
  duplicate?: boolean
}

/** What the thread looked like before this message. */
export async function loadThreadState(db: SupabaseClient, threadId: string | null): Promise<ThreadState> {
  if (!threadId) return { agentReplied: false, humanRepliedAfterInquiry: false, priorInbound: 0 }
  const [{ data: msgs }, { data: sent }] = await Promise.all([
    db.from('agent_email_messages').select('direction, received_at, outcome').eq('gmail_thread_id', threadId).order('received_at', { ascending: true }),
    db.from('agent_email_replies').select('id').eq('gmail_thread_id', threadId).eq('status', 'sent').limit(1),
  ])
  const rows = (msgs ?? []) as Array<{ direction: string; received_at: string | null; outcome: string | null }>
  const inbound = rows.filter(r => r.direction === 'inbound' && r.outcome !== 'human_reply')
  const lastInboundAt = inbound.at(-1)?.received_at ?? null
  const humanAfter = rows.some(r =>
    (r.direction === 'outbound_human' || r.outcome === 'human_reply') &&
    (!lastInboundAt || (r.received_at ?? '') >= lastInboundAt))
  return { agentReplied: (sent ?? []).length > 0, humanRepliedAfterInquiry: humanAfter, priorInbound: inbound.length }
}

function messageRow(email: InboundEmail, deliveryPath: string | null) {
  return {
    gmail_message_id: email.gmailMessageId,
    gmail_thread_id: email.gmailThreadId,
    internet_message_id: email.internetMessageId,
    in_reply_to: email.inReplyTo,
    references_ids: email.references,
    direction: 'inbound',
    delivery_path: email.source === 'replay' ? 'replay' : deliveryPath,
    from_addr: email.from.addr.toLowerCase(),
    from_name: email.from.name,
    from_domain: email.from.addr.toLowerCase().split('@')[1] ?? null,
    to_addrs: email.to.map(a => a.addr.toLowerCase()),
    cc_addrs: email.cc.map(a => a.addr.toLowerCase()),
    subject: email.subject,
    snippet: stripQuotedHistory(email.bodyText).slice(0, 200) || null,
    body_text: email.bodyText,
    headers: pickFilterHeaders(email.headers),
    received_at: email.receivedAt,
  }
}

const KEPT_HEADERS = ['auto-submitted', 'x-autoreply', 'x-autorespond', 'x-auto-response-suppress', 'precedence', 'list-id', 'list-unsubscribe', 'x-mailer-type', 'message-id', 'in-reply-to']
function pickFilterHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of KEPT_HEADERS) if (h[k] !== undefined) out[k] = String(h[k]).slice(0, 300)
  return out
}

export async function ingestEmail(
  db: SupabaseClient,
  email: InboundEmail,
  opts: { settings?: AgentSettings; composer?: ComposerStage; partnerReply?: PartnerReplyStage } = {},
): Promise<IngestResult> {
  const settings = opts.settings ?? await loadAgentSettings(db)

  // Idempotency: a re-polled Gmail message is a no-op.
  if (email.gmailMessageId) {
    const { data: dup } = await db.from('agent_email_messages').select('id, outcome').eq('gmail_message_id', email.gmailMessageId).maybeSingle()
    if (dup) return { messageId: dup.id as string, outcome: (dup.outcome as string) ?? 'seen', duplicate: true }
  }

  const thread = await loadThreadState(db, email.gmailThreadId)
  const verdict = applyHardFilters(email, settings, thread)
  const deliveryPath = verdict.pass ? verdict.deliveryPath : null

  const { data: inserted, error } = await db.from('agent_email_messages')
    .insert({ ...messageRow(email, deliveryPath), outcome: verdict.pass ? 'accepted' : verdict.reason === 'human_reply' ? 'human_reply' : `dropped_${verdict.reason}`, outcome_detail: verdict.pass ? null : verdict.detail, processed_at: new Date().toISOString() })
    .select('id').single()
  if (error) throw new Error(`agent_email_messages insert failed: ${error.message}`)
  const messageId = inserted.id as string

  if (!verdict.pass) {
    // A partner follow-up on a thread Cassie answered is not a drop: it is the outcome
    // signal. Classify it and flag a person; Cassie never replies twice in a thread.
    if (verdict.reason === 'thread_actioned' && opts.partnerReply) {
      try {
        const res = await opts.partnerReply(db, settings, { messageId, email, cleanBody: stripQuotedHistory(email.bodyText) })
        await db.from('agent_email_messages').update({ outcome: res.outcome, outcome_detail: res.detail ?? null }).eq('id', messageId)
        return { messageId, ...res }
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e)
        await db.from('agent_email_messages').update({ outcome: 'partner_reply', outcome_detail: `unclassified: ${detail.slice(0, 300)}` }).eq('id', messageId)
        return { messageId, outcome: 'partner_reply', detail }
      }
    }
    return { messageId, outcome: verdict.reason === 'human_reply' ? 'human_reply' : `dropped_${verdict.reason}`, detail: verdict.detail }
  }

  const cleanBody = stripQuotedHistory(email.bodyText)
  const identifiers = extractIdentifiers(cleanBody, { excludeEmails: [email.from.addr, settings.mailbox_address, ...email.to.map(a => a.addr), ...email.cc.map(a => a.addr)] })
  const accepted: AcceptedMessage = { messageId, email, cleanBody, identifiers, deliveryPath: verdict.deliveryPath, thread }

  if (!opts.composer) {
    await db.from('agent_email_messages').update({ outcome: 'accepted', outcome_detail: `identifiers: ${JSON.stringify({ pos: identifiers.pos, phones: identifiers.phones, emails: identifiers.emails })}` }).eq('id', messageId)
    return { messageId, outcome: 'accepted', detail: 'composer not configured' }
  }
  try {
    const res = await opts.composer(db, settings, accepted)
    await db.from('agent_email_messages').update({ outcome: res.outcome, outcome_detail: res.detail ?? null }).eq('id', messageId)
    return { messageId, ...res }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    await db.from('agent_email_messages').update({ outcome: 'error', outcome_detail: detail.slice(0, 500) }).eq('id', messageId)
    return { messageId, outcome: 'error', detail }
  }
}

/** Build an InboundEmail from a pasted message (admin replay / tests). */
export function replayEmail(input: { from: string; fromName?: string | null; to?: string; cc?: string; subject: string; body: string; headers?: Record<string, string>; threadId?: string | null }): InboundEmail {
  const parseList = (s?: string) => (s ?? '').split(/[,;]+/).map(x => x.trim()).filter(Boolean).map(addr => ({ addr, name: null }))
  return {
    source: 'replay',
    gmailMessageId: null,
    gmailThreadId: input.threadId ?? null,
    internetMessageId: null,
    inReplyTo: null,
    references: [],
    from: { addr: input.from.trim(), name: input.fromName ?? null },
    to: parseList(input.to),
    cc: parseList(input.cc),
    subject: input.subject,
    bodyText: input.body,
    headers: Object.fromEntries(Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    receivedAt: new Date().toISOString(),
  }
}
