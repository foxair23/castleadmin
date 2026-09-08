import type { SupabaseClient } from '@supabase/supabase-js'
import type Anthropic from '@anthropic-ai/sdk'
import { llm, isLlmConfigured, describeLlmError } from '@/lib/agent/llm'
import type { AgentSettings } from '@/lib/agent/settings'
import { enqueueForSubscribers, hasRecentNotification } from '@/lib/notifications/enqueue'
import { appUrl } from '@/lib/config/domains'
import type { InboundEmail } from './types'

// Outcome monitoring — the confusion signal (PRD §10). Human review says whether a
// draft LOOKED right; the partner's reply is the only signal for what actually landed,
// and the only one that covers auto-sent replies nobody read.
//
//   • A partner writing again in a thread Cassie answered is classified: resolved,
//     confused, or a new question. Cassie never replies again in that thread.
//   • Confused / new question → flagged in Review ("Follow-ups") and the team is emailed,
//     so a person answers the partner. Confused also feeds the corpus via the reviewer's
//     correction note.
//   • Confusion rate is tracked per question type + match tier over recent sent replies.
//     A tier above the threshold (with enough samples) reverts to draft mode on its own
//     and raises an alert. Directional, not a verdict: the UI always shows the thread.

export type OutcomeClass = 'resolved' | 'confused' | 'new_question'

const TOOL: Anthropic.Tool = {
  name: 'classify_partner_reply',
  description: "Classify a trade partner's reply to an email Castle's assistant sent them.",
  strict: true,
  input_schema: {
    type: 'object', additionalProperties: false, required: ['classification', 'reason'],
    properties: {
      classification: { type: 'string', enum: ['resolved', 'confused', 'new_question'], description: 'resolved = thanks / acknowledgement / nothing further asked. confused = they re-ask the same thing, say the answer did not address their question, or say the information was wrong. new_question = a different question about the same or another job.' },
      reason: { type: 'string', description: 'One short sentence explaining the choice.' },
    },
  },
}

export async function classifyPartnerReply(input: { ourReply: string; theirReply: string; model: string }): Promise<{ classification: OutcomeClass; reason: string } | null> {
  if (!isLlmConfigured()) return null
  const res = await llm().messages.create({
    model: input.model, max_tokens: 256, tools: [TOOL], tool_choice: { type: 'tool', name: 'classify_partner_reply' },
    system: 'You classify a partner\'s follow-up to a status email from a garage door installer. Be conservative: a polite thanks with no question is resolved; only call it confused when they clearly did not get what they asked for or say something was wrong.',
    messages: [{ role: 'user', content: `WE SENT:\n${input.ourReply.slice(0, 3000)}\n\nTHEY REPLIED:\n${input.theirReply.slice(0, 3000)}` }],
  })
  const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
  if (!tu) return null
  const i = tu.input as { classification: OutcomeClass; reason: string }
  return { classification: (['resolved', 'confused', 'new_question'] as const).includes(i.classification) ? i.classification : 'new_question', reason: (i.reason ?? '').slice(0, 300) }
}

/** Stage 8 — a partner wrote in a thread Cassie already answered. Record the outcome, flag people. */
export async function recordPartnerReply(db: SupabaseClient, settings: AgentSettings, input: { messageId: string; email: InboundEmail; cleanBody: string }): Promise<{ outcome: string; detail?: string }> {
  const threadId = input.email.gmailThreadId
  if (!threadId) return { outcome: 'partner_reply', detail: 'no thread id' }
  const { data: sent } = await db.from('agent_email_replies').select('id, sent_text, composed_text, question_type, resolve_tier, approval_path, sf_job_number').eq('gmail_thread_id', threadId).eq('status', 'sent').order('sent_at', { ascending: false }).limit(1).maybeSingle()
  if (!sent) return { outcome: 'partner_reply', detail: 'no sent reply found in thread' }

  let cls: { classification: OutcomeClass; reason: string } | null = null
  let classifiedBy: 'model' | 'human' = 'model'
  try { cls = await classifyPartnerReply({ ourReply: (sent.sent_text ?? sent.composed_text ?? '') as string, theirReply: input.cleanBody, model: settings.classifier_model }) }
  catch (e) { cls = { classification: 'new_question', reason: `classifier failed: ${describeLlmError(e)}` }; classifiedBy = 'model' }
  if (!cls) { cls = { classification: 'new_question', reason: 'classifier unavailable' } }

  await db.from('agent_email_outcomes').insert({ reply_id: sent.id, partner_message_id: input.messageId, classification: cls.classification, classified_by: classifiedBy, reason: cls.reason })
  if (cls.classification === 'confused') await db.from('agent_email_feedback').insert({ reply_id: sent.id, kind: 'confused', note: `Partner reply read as confused: ${cls.reason}\n\n"${input.cleanBody.slice(0, 600)}"` })

  if (cls.classification !== 'resolved') {
    try { await notifyFollowUp(db, settings, { replyId: sent.id as string, email: input.email, body: input.cleanBody, classification: cls.classification, reason: cls.reason, jobNumber: (sent.sf_job_number as string | null) ?? null }) }
    catch (e) { console.error('[cassie] follow-up notify failed:', e instanceof Error ? e.message : e) }
  }
  return { outcome: 'partner_reply', detail: `${cls.classification}: ${cls.reason}` }
}

async function notifyFollowUp(db: SupabaseClient, settings: AgentSettings, f: { replyId: string; email: InboundEmail; body: string; classification: OutcomeClass; reason: string; jobNumber: string | null }) {
  const who = f.email.from.name ? `${f.email.from.name} <${f.email.from.addr}>` : f.email.from.addr
  const label = f.classification === 'confused' ? 'did not get what they needed' : 'asked a new question'
  const url = `${appUrl()}/admin/cassie?reply=${f.replyId}`
  const subject = `Cassie: partner ${label} — ${f.email.subject}`.slice(0, 140)
  const text = `${who} replied to Cassie's answer and ${label}.\n\nWhy: ${f.reason}\n${f.jobNumber ? `Job: ${f.jobNumber}\n` : ''}\nTheir reply:\n${f.body.slice(0, 1500)}\n\nCassie will not reply again in this thread. Please answer from the office inbox.\n${url}`
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  await enqueueForSubscribers({
    notificationTypeKey: 'cassie_escalation', subject, bodyText: text, relatedEntityType: 'agent_email_reply', relatedEntityId: f.replyId,
    bodyHtml: `<p><b>${esc(who)}</b> replied to Cassie's answer and <b>${label}</b>.</p><p><i>${esc(f.reason)}</i></p>${f.jobNumber ? `<p>Job ${esc(f.jobNumber)}</p>` : ''}<blockquote style="white-space:pre-wrap;color:#374151">${esc(f.body.slice(0, 1500))}</blockquote><p>Cassie will not reply again in this thread. Please answer from the office inbox.</p><p><a href="${url}">Open in Castle Admin → Cassie → Review</a></p>`,
  })
  const { sendEmail } = await import('@/lib/notifications/resend')
  for (const to of settings.escalation_extra_emails) { try { await sendEmail({ to, subject, text, html: `<pre style="white-space:pre-wrap;font-family:sans-serif">${esc(text)}</pre>` }) } catch { /* best effort */ } }
}

// ── Confusion rate ──────────────────────────────────────────────────────────

export interface OutcomeRow { question_type: string | null; resolve_tier: string | null; approval_path: string | null; classification: OutcomeClass }
export interface TierRate { key: string; questionType: string; tier: string; sample: number; confused: number; rate: number; autoSample: number; autoConfused: number }

/** Per question type + tier: how many classified outcomes, how many confused. Pure. */
export function computeConfusionRates(rows: OutcomeRow[]): TierRate[] {
  const m = new Map<string, TierRate>()
  for (const r of rows) {
    const qt = r.question_type ?? 'other', tier = r.resolve_tier ?? 'none', key = `${qt}:${tier}`
    const t = m.get(key) ?? { key, questionType: qt, tier, sample: 0, confused: 0, rate: 0, autoSample: 0, autoConfused: 0 }
    t.sample++; if (r.classification === 'confused') t.confused++
    if (r.approval_path === 'auto') { t.autoSample++; if (r.classification === 'confused') t.autoConfused++ }
    t.rate = t.sample ? t.confused / t.sample : 0
    m.set(key, t)
  }
  return [...m.values()].sort((a, b) => b.rate - a.rate || b.sample - a.sample)
}

/** Which tiers should be paused now (pure): rate ≥ threshold with at least min samples, and not already paused. */
export function tiersToPause(rates: TierRate[], settings: AgentSettings): TierRate[] {
  return rates.filter(t => t.tier !== 'none' && t.sample >= settings.confusion_min_sample && t.rate >= settings.confusion_threshold && !settings.paused_tiers[t.key])
}

/** Load the last 30 days of classified outcomes joined to their reply. */
export async function loadRecentOutcomes(db: SupabaseClient, days = 30): Promise<OutcomeRow[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const { data } = await db.from('agent_email_outcomes').select('classification, reply:agent_email_replies!inner(question_type, resolve_tier, approval_path)').gte('created_at', since).limit(2000)
  return ((data ?? []) as unknown as Array<{ classification: OutcomeClass; reply: { question_type: string | null; resolve_tier: string | null; approval_path: string | null } | Array<{ question_type: string | null; resolve_tier: string | null; approval_path: string | null }> }>).map(r => {
    const rep = Array.isArray(r.reply) ? r.reply[0] : r.reply
    return { classification: r.classification, question_type: rep?.question_type ?? null, resolve_tier: rep?.resolve_tier ?? null, approval_path: rep?.approval_path ?? null }
  })
}

/** Auto-revert (PRD §10 safety valve). Runs from the poll. Pauses degrading tiers and alerts once per day per tier. */
export async function runConfusionCheck(db: SupabaseClient, settings: AgentSettings): Promise<{ rates: TierRate[]; paused: string[] }> {
  const rates = computeConfusionRates(await loadRecentOutcomes(db))
  const toPause = tiersToPause(rates, settings)
  if (!toPause.length) return { rates, paused: [] }
  const paused = { ...settings.paused_tiers }
  for (const t of toPause) paused[t.key] = { since: new Date().toISOString(), rate: Math.round(t.rate * 1000) / 1000 }
  await db.from('agent_settings').update({ paused_tiers: paused, updated_at: new Date().toISOString() }).eq('id', 1)
  // Anything queued on that tier goes back to review.
  for (const t of toPause) {
    const { data: pulled } = await db.from('agent_email_replies').update({ status: 'draft', send_after: null, approval_path: null, cancel_reason: 'tier_paused', updated_at: new Date().toISOString() })
      .eq('status', 'queued').eq('approval_path', 'auto').eq('question_type', t.questionType).eq('resolve_tier', t.tier).select('id')
    for (const r of pulled ?? []) await db.from('agent_email_feedback').insert({ reply_id: r.id, kind: 'note', note: `Tier ${t.key} paused by confusion rate (${Math.round(t.rate * 100)}%); returned to review.` })
    const recent = await hasRecentNotification({ notificationTypeKey: 'cassie_tier_reverted', relatedEntityType: 'agent_tier', relatedEntityId: t.key, withinHours: 24 })
    if (recent) continue
    const url = `${appUrl()}/admin/cassie`
    const text = `Auto-send is paused for "${t.questionType}" questions matched by ${t.tier}.\n\n${t.confused} of the last ${t.sample} partner replies on that tier read as confused (${Math.round(t.rate * 100)}%, threshold ${Math.round(settings.confusion_threshold * 100)}%). Those drafts now wait for a person.\n\nReview the confused threads under Cassie → Review → Follow-ups, then clear the pause under Settings → Auto-send when you are satisfied.\n${url}`
    await enqueueForSubscribers({ notificationTypeKey: 'cassie_tier_reverted', subject: `Cassie: auto-send paused for ${t.questionType} via ${t.tier}`, bodyText: text, bodyHtml: `<pre style="white-space:pre-wrap;font-family:sans-serif">${text.replace(/</g, '&lt;')}</pre>`, relatedEntityType: 'agent_tier', relatedEntityId: t.key })
  }
  return { rates, paused: toPause.map(t => t.key) }
}
