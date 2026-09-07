import type { SupabaseClient } from '@supabase/supabase-js'
import { appUrl } from '@/lib/config/domains'
import { enqueueForSubscribers } from '@/lib/notifications/enqueue'
import { sendEmail } from '@/lib/notifications/resend'
import { renderCassieEscalation } from '@/lib/notifications/templates/cassie-escalation'
import type { AgentSettings } from '@/lib/agent/settings'

// Review panel service (PRD §12). The human decisions on a draft — approve, edit,
// reject, escalate, feedback — and the learning side-effects each one has (PRD §9):
//   • approve (unedited)  → style corpus 'human_approved'
//   • edit + approve      → style corpus 'human_edit' with BOTH texts (the diff is the signal)
//   • reject / edit note  → agent_email_feedback
//   • escalate            → agent_email_feedback + internal notification (Resend, never partner mail)
// Approving never sends directly: it QUEUES the reply. The sender (chunk 8) picks up
// queued rows, re-verifies facts, and sends. Until a mailbox exists, queued rows wait.

export type ReplyStatus = 'draft' | 'queued' | 'sent' | 'cancelled' | 'superseded' | 'rejected' | 'escalated' | 'failed'

export interface ReviewItem {
  id: string
  message_id: string
  status: ReplyStatus
  created_at: string
  question_type: string | null
  question_summary: string | null
  resolve_status: string | null
  resolve_tier: string | null
  sf_job_id: string | null
  sf_job_number: string | null
  live_fetched_at: string | null
  composed_subject: string | null
  composed_text: string | null
  sent_text: string | null
  was_edited: boolean
  claims: Array<{ text: string; factIds: string[]; grounded: boolean; unsupported: string[] }>
  unsourced_claims: string[]
  hard_fail_reasons: string[]
  auto_send_blockers: string[]
  confidence: number | null
  confidence_breakdown: Record<string, unknown>
  send_after: string | null
  sent_at: string | null
  approval_path: string | null
  cancel_reason: string | null
  error: string | null
  applied_instruction_ids: string[]
  charter_version: number | null
  model: string | null
  // joined
  message: { from_addr: string | null; from_name: string | null; from_domain: string | null; subject: string | null; body_text: string | null; received_at: string | null; delivery_path: string | null; gmail_thread_id: string | null } | null
  sources: Array<{ source_type: string; ref_id: string | null; ref_label: string | null; fields: Record<string, unknown>; retrieved_at: string }>
  feedback: Array<{ kind: string; note: string; created_at: string }>
}

const REPLY_COLS = 'id, message_id, status, created_at, question_type, question_summary, resolve_status, resolve_tier, sf_job_id, sf_job_number, live_fetched_at, composed_subject, composed_text, sent_text, was_edited, claims, unsourced_claims, hard_fail_reasons, auto_send_blockers, confidence, confidence_breakdown, send_after, sent_at, approval_path, cancel_reason, error, applied_instruction_ids, charter_version, model'

export async function loadReviewItems(db: SupabaseClient, opts: { statuses: ReplyStatus[]; limit?: number }): Promise<ReviewItem[]> {
  const { data: replies } = await db.from('agent_email_replies').select(REPLY_COLS).in('status', opts.statuses).order('created_at', { ascending: false }).limit(opts.limit ?? 200)
  const rows = (replies ?? []) as unknown as Omit<ReviewItem, 'message' | 'sources' | 'feedback'>[]
  if (rows.length === 0) return []
  const ids = rows.map(r => r.id), msgIds = [...new Set(rows.map(r => r.message_id))]
  const [{ data: msgs }, { data: sources }, { data: fb }] = await Promise.all([
    db.from('agent_email_messages').select('id, from_addr, from_name, from_domain, subject, body_text, received_at, delivery_path, gmail_thread_id').in('id', msgIds),
    db.from('agent_email_sources').select('reply_id, source_type, ref_id, ref_label, fields, retrieved_at').in('reply_id', ids),
    db.from('agent_email_feedback').select('reply_id, kind, note, created_at').in('reply_id', ids).order('created_at', { ascending: true }),
  ])
  const msgById = new Map((msgs ?? []).map(m => [m.id as string, m]))
  const srcBy = new Map<string, ReviewItem['sources']>(), fbBy = new Map<string, ReviewItem['feedback']>()
  for (const s of (sources ?? []) as Array<{ reply_id: string } & ReviewItem['sources'][number]>) { const a = srcBy.get(s.reply_id) ?? []; a.push(s); srcBy.set(s.reply_id, a) }
  for (const f of (fb ?? []) as Array<{ reply_id: string } & ReviewItem['feedback'][number]>) { const a = fbBy.get(f.reply_id) ?? []; a.push(f); fbBy.set(f.reply_id, a) }
  const items: ReviewItem[] = rows.map(r => ({
    ...r,
    confidence: r.confidence == null ? null : Number(r.confidence),
    message: (msgById.get(r.message_id) as ReviewItem['message']) ?? null,
    sources: (srcBy.get(r.id) ?? []).filter(s => s.source_type !== 'thread_message' || true),
    feedback: fbBy.get(r.id) ?? [],
  }))
  // Queue order: highest confidence first, then newest (PRD §12 "sorted by confidence").
  if (opts.statuses.includes('draft')) items.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0) || b.created_at.localeCompare(a.created_at))
  return items
}

async function getReply(db: SupabaseClient, id: string) {
  const { data, error } = await db.from('agent_email_replies').select('id, message_id, status, composed_text, composed_subject, question_type, question_summary, sf_job_number, resolve_status, resolve_tier, hard_fail_reasons, gmail_thread_id').eq('id', id).single()
  if (error || !data) throw new Error('Reply not found')
  return data as { id: string; message_id: string; status: string; composed_text: string | null; composed_subject: string | null; question_type: string | null; question_summary: string | null; sf_job_number: string | null; resolve_status: string | null; resolve_tier: string | null; hard_fail_reasons: string[]; gmail_thread_id: string | null }
}

function assertActionable(status: string) {
  if (status !== 'draft' && status !== 'queued') throw new Error(`This reply is already ${status}; it cannot be changed.`)
}

/** Approve (optionally with edits). Queues the reply; the sender does the rest. */
export async function approveReply(db: SupabaseClient, id: string, input: { text: string; note: string | null; userId: string }): Promise<void> {
  const r = await getReply(db, id)
  assertActionable(r.status)
  const finalText = input.text.trim()
  if (!finalText) throw new Error('The reply text is empty.')
  const edited = finalText !== (r.composed_text ?? '').trim()
  const now = new Date().toISOString()
  const { error } = await db.from('agent_email_replies').update({
    status: 'queued', sent_text: finalText, was_edited: edited, approval_path: edited ? 'edited' : 'approved',
    approved_by: input.userId, approved_at: now, send_after: now, updated_at: now,
  }).eq('id', id)
  if (error) throw new Error(error.message)

  // Learning (PRD §9.1): only human-verified replies become examples.
  const { data: msg } = await db.from('agent_email_messages').select('body_text').eq('id', r.message_id).maybeSingle()
  const inquiry = msg?.body_text ? stripForCorpus(msg.body_text as string) : null
  await db.from('agent_style_examples').insert({
    source: edited ? 'human_edit' : 'human_approved', audience: 'partner', question_type: r.question_type,
    inquiry_text: inquiry, ai_text: r.composed_text, final_text: stripDisclosure(finalText), reply_id: id, created_by: input.userId,
  })
  if (input.note?.trim()) await db.from('agent_email_feedback').insert({ reply_id: id, kind: 'edit', note: input.note.trim(), user_id: input.userId })
}

export async function rejectReply(db: SupabaseClient, id: string, input: { note: string | null; userId: string }): Promise<void> {
  const r = await getReply(db, id)
  assertActionable(r.status)
  const now = new Date().toISOString()
  const { error } = await db.from('agent_email_replies').update({ status: 'rejected', rejected_by: input.userId, rejected_at: now, updated_at: now }).eq('id', id)
  if (error) throw new Error(error.message)
  if (input.note?.trim()) await db.from('agent_email_feedback').insert({ reply_id: id, kind: 'reject', note: input.note.trim(), user_id: input.userId })
}

/** Escalate to a person: mark the thread, notify subscribers + extra inboxes. Cassie stays out of the thread. */
export async function escalateReply(db: SupabaseClient, id: string, input: { note: string | null; userId: string; userName: string | null; settings: AgentSettings }): Promise<{ notified: number }> {
  const r = await getReply(db, id)
  assertActionable(r.status)
  const now = new Date().toISOString()
  const { error } = await db.from('agent_email_replies').update({ status: 'escalated', rejected_by: input.userId, rejected_at: now, cancel_reason: 'escalated', updated_at: now }).eq('id', id)
  if (error) throw new Error(error.message)
  if (input.note?.trim()) await db.from('agent_email_feedback').insert({ reply_id: id, kind: 'escalate', note: input.note.trim(), user_id: input.userId })

  const { data: msg } = await db.from('agent_email_messages').select('from_addr, from_name, from_domain, subject, body_text').eq('id', r.message_id).maybeSingle()
  const domain = (msg?.from_domain as string | null) ?? ''
  const company = /homedepot/.test(domain) ? 'Home Depot' : /clopay/.test(domain) ? 'Clopay' : /genie/.test(domain) ? 'Genie' : domain || 'partner'
  const { renderCassieEscalation: render } = { renderCassieEscalation }
  const { subject, bodyHtml, bodyText } = render({
    partnerName: (msg?.from_name as string | null) ?? null, partnerEmail: (msg?.from_addr as string) ?? '', company,
    subject: (msg?.subject as string | null) ?? '(no subject)', question: r.question_summary ?? stripForCorpus((msg?.body_text as string | null) ?? '').slice(0, 800),
    jobNumber: r.sf_job_number, matchNote: r.resolve_status === 'matched' ? `matched by ${r.resolve_tier}` : r.resolve_status === 'ambiguous' ? 'more than one job matched' : 'no job matched',
    reasons: r.hard_fail_reasons?.length ? r.hard_fail_reasons : ['escalated by reviewer'], escalatedBy: input.userName, note: input.note?.trim() || null,
    reviewUrl: `${appUrl()}/admin/cassie?reply=${id}`,
  })
  let notified = await enqueueForSubscribers({ notificationTypeKey: 'cassie_escalation', subject, bodyHtml, bodyText, relatedEntityType: 'agent_email_reply', relatedEntityId: id })
  for (const email of input.settings.escalation_extra_emails) {
    try { await sendEmail({ to: email, subject, html: bodyHtml, text: bodyText }); notified++ } catch { /* best effort */ }
  }
  return { notified }
}

/** Post-send (or any time) free-text note on a reply. */
export async function addReplyFeedback(db: SupabaseClient, id: string, input: { kind: 'post_send' | 'confused' | 'note'; note: string; userId: string }): Promise<void> {
  if (!input.note.trim()) throw new Error('Note is empty.')
  const { error } = await db.from('agent_email_feedback').insert({ reply_id: id, kind: input.kind, note: input.note.trim(), user_id: input.userId })
  if (error) throw new Error(error.message)
}

/** Un-queue a reply that has not sent yet (reviewer changed their mind). */
export async function cancelQueuedReply(db: SupabaseClient, id: string, userId: string): Promise<void> {
  const r = await getReply(db, id)
  if (r.status !== 'queued') throw new Error(`Only queued replies can be cancelled (this one is ${r.status}).`)
  const { error } = await db.from('agent_email_replies').update({ status: 'draft', send_after: null, approval_path: null, approved_by: null, approved_at: null, sent_text: null, was_edited: false, updated_at: new Date().toISOString() }).eq('id', id)
  if (error) throw new Error(error.message)
  await db.from('agent_email_feedback').insert({ reply_id: id, kind: 'note', note: 'Un-queued by reviewer; back to draft.', user_id: userId })
}

// Keep the corpus about voice, not boilerplate: drop greeting/signature/disclosure lines.
export function stripDisclosure(text: string): string {
  const cut = text.indexOf('\n—\n')
  let t = cut >= 0 ? text.slice(0, cut) : text
  t = t.replace(/^\s*Hi[^\n]*,\s*\n+/i, '').replace(/\n+\s*Cassie\s*\n\s*Castle Garage Doors & Gates\s*$/i, '')
  return t.trim()
}
function stripForCorpus(body: string): string {
  // Cheap quote strip without importing the filter module (keeps this file free of the
  // pipeline dependency chain for the admin page).
  return body.split('\n').filter(l => !l.startsWith('>')).join('\n').split(/\nOn .{5,120} wrote:/)[0].trim().slice(0, 2000)
}
