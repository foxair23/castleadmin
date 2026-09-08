import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentSettings, QuestionType } from '@/lib/agent/settings'
import { isLlmConfigured, describeLlmError } from '@/lib/agent/llm'
import { getActiveCharter, listInstructions, listStyleExamples } from '@/lib/agent/knowledge'
import type { LiveJobFacts } from '@/lib/agent/live-refresh'
import { classifyInquiry } from './classify'
import { buildGrounding, type GroundingPack } from './grounding'
import { composeReply, renderBody, renderEmail } from './compose'
import { checkGrounding } from './grounding-check'
import { computeConfidence } from './confidence'
import { decideRoute } from './routing'
import type { AcceptedMessage, ComposerStage } from './pipeline'

// Stages 3–4 + the draft record (PRD §5). Every accepted message ends here as a
// DRAFT in agent_email_replies with its sources and its unsourced-claim list. Routing
// to auto-send (Stage 5) is a later chunk; until then everything is a draft.
//
// Order of operations: classify → ground (resolve + live read + library) → compose →
// grounding check → store. A failure at any model step still stores a reply row with
// status 'failed' and the reason, so nothing disappears silently.

const companyFor = (domain: string): string =>
  /homedepot/.test(domain) ? 'Home Depot' : /clopay/.test(domain) ? 'Clopay' : /genie/.test(domain) ? 'Genie' : domain

const firstName = (name: string | null, addr: string): string | null => {
  const n = (name ?? '').trim()
  if (n) { const parts = n.replace(/,/g, ' ').split(/\s+/); return /,/.test(name!) && parts.length > 1 ? parts[1] : parts[0] }
  const local = addr.split('@')[0] ?? ''
  const m = /^([a-z]{2,})[._-]/i.exec(local)
  return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : null
}

export interface ComposerOptions {
  /** Test hook: inject live facts instead of reading Service Fusion. */
  liveOverride?: LiveJobFacts | null
  /** Set when this run replaces an earlier reply whose facts changed before sending. */
  recomposedFrom?: string
  /** A team member's answer from Google Chat (PRD §11). Never forwarded verbatim: it becomes
   *  a fact the composer must write FROM, and it marks the reply chat-sourced (no auto-send). */
  chatAnswer?: { askId: string; text: string; responder: string }
  /** Skip posting a Chat ask even if the reply cannot be answered (used when recomposing from one). */
  noChatAsk?: boolean
}

export function makeComposerStage(opts: ComposerOptions = {}): ComposerStage {
  return async (db, settings, accepted) => runComposer(db, settings, accepted, opts)
}

export async function runComposer(db: SupabaseClient, settings: AgentSettings, a: AcceptedMessage, opts: ComposerOptions = {}): Promise<{ outcome: string; detail?: string; replyId?: string }> {
  const fromDomain = a.email.from.addr.toLowerCase().split('@')[1] ?? ''
  const base = {
    message_id: a.messageId,
    gmail_thread_id: a.email.gmailThreadId,
    identifiers: { pos: a.identifiers.pos, phones: a.identifiers.phones, emails: a.identifiers.emails },
    model: settings.composer_model,
    prompt_version: settings.prompt_version,
  }

  if (!isLlmConfigured()) {
    await db.from('agent_email_replies').insert({ ...base, status: 'failed', error: 'ANTHROPIC_API_KEY is not set' })
    return { outcome: 'error', detail: 'ANTHROPIC_API_KEY is not set' }
  }

  // 3a. Classify.
  let questionType: QuestionType = 'other', summary = a.email.subject, customerName: string | null = null, extraPos: string[] = [], multi = false, asksHuman = false
  try {
    const c = await classifyInquiry({ subject: a.email.subject, body: a.cleanBody, fromDomain, model: settings.classifier_model })
    if (c) { questionType = c.questionType; summary = c.summary || summary; customerName = c.customerName; extraPos = c.extraPos; multi = c.isMultiPart; asksHuman = c.asksForHuman }
  } catch (e) {
    const err = describeLlmError(e)
    await db.from('agent_email_replies').insert({ ...base, status: 'failed', error: `classify: ${err}` })
    return { outcome: 'error', detail: `classify: ${err}` }
  }
  const pos = [...new Set([...a.identifiers.pos, ...extraPos])]
  const identifiers = { pos, customerName, email: a.identifiers.email, phone: a.identifiers.phone }

  // 3b. Ground.
  let pack: GroundingPack
  try {
    pack = await buildGrounding(db, { identifiers, questionType, questionText: `${a.email.subject}\n${a.cleanBody}`, settings, liveOverride: opts.liveOverride, extraFacts: opts.chatAnswer ? [{ source: 'chat_answer', refId: opts.chatAnswer.askId, label: `Team answer · ${opts.chatAnswer.responder}`, text: opts.chatAnswer.text, values: [] }] : [] })
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e)
    await db.from('agent_email_replies').insert({ ...base, question_type: questionType, question_summary: summary, identifiers, status: 'failed', error: `grounding: ${err}` })
    return { outcome: 'error', detail: `grounding: ${err}` }
  }
  const matched = pack.resolve.status === 'matched' ? pack.resolve : null
  const liveFacts = pack.live?.status === 'fresh' ? pack.live.facts : null

  // 4. Compose.
  const [charter, instructions, styles] = await Promise.all([getActiveCharter(db), listInstructions(db), listStyleExamples(db)])
  const { pickStyleExamples } = await import('./learning')
  const styleExamples = pickStyleExamples(styles, questionType, `${a.email.subject}\n${a.cleanBody}`, 8)
  const thread = await loadThreadText(db, a.email.gmailThreadId, a.messageId)
  let composed
  try {
    composed = await composeReply({
      settings, charter, instructions, styleExamples, facts: pack.facts, gaps: pack.gaps, questionType, questionSummary: summary,
      partner: { fromName: a.email.from.name, fromAddr: a.email.from.addr, company: companyFor(fromDomain) },
      subject: a.email.subject, body: a.cleanBody, thread,
    })
  } catch (e) {
    const err = describeLlmError(e)
    await db.from('agent_email_replies').insert({ ...base, question_type: questionType, question_summary: summary, identifiers, resolve_status: pack.resolve.status, resolve_tier: 'tier' in pack.resolve ? pack.resolve.tier : null, sf_job_id: matched?.job.id ?? null, sf_job_number: matched?.job.number ?? null, status: 'failed', error: `compose: ${err}` })
    return { outcome: 'error', detail: `compose: ${err}` }
  }
  if (!composed) {
    await db.from('agent_email_replies').insert({ ...base, question_type: questionType, question_summary: summary, identifiers, status: 'failed', error: 'composer returned nothing' })
    return { outcome: 'error', detail: 'composer returned nothing' }
  }

  // Grounding check — in code.
  const report = checkGrounding(composed.claims, pack.facts)
  const body = renderBody(composed.claims)
  const text = renderEmail(body, settings, firstName(a.email.from.name, a.email.from.addr))

  // Hard-fail reasons that block auto-send regardless of any threshold (PRD §6.3).
  const hardFail: string[] = []
  if (!report.fullyGrounded) hardFail.push('ungrounded')
  if (pack.resolve.status === 'ambiguous') hardFail.push('multi_match')
  if (pack.resolve.status === 'none') hardFail.push('no_match')
  if (matched && pack.live?.status !== 'fresh') hardFail.push('refresh_failed')
  if (multi) hardFail.push('multi_part')
  if (asksHuman) hardFail.push('asks_for_human')
  if (composed.couldNotAnswer) hardFail.push('could_not_answer')
  if (opts.chatAnswer) hardFail.push('chat_sourced')   // a Chat answer authorises one reply with approval, never auto-send (PRD §11)

  const { score: confidence, breakdown } = computeConfidence({
    resolveStatus: pack.resolve.status, resolveTier: 'tier' in pack.resolve ? pack.resolve.tier : null, questionType,
    fullyGrounded: report.fullyGrounded, unsourcedCount: report.unsourced.length, liveFresh: pack.live?.status === 'fresh', hardFailReasons: hardFail,
  }, settings)

  // Stage 5 — route. Auto-send only when every hard rule AND every setting agrees.
  const route = decideRoute({
    resolveStatus: pack.resolve.status, resolveTier: 'tier' in pack.resolve ? pack.resolve.tier : null, questionType,
    fullyGrounded: report.fullyGrounded, unsourcedCount: report.unsourced.length, liveFresh: pack.live?.status === 'fresh', hardFailReasons: hardFail,
  }, confidence, settings)

  const subject = /^re:/i.test(a.email.subject) ? a.email.subject : `Re: ${a.email.subject}`
  const { data: reply, error } = await db.from('agent_email_replies').insert({
    ...base,
    question_type: questionType, question_summary: summary, identifiers,
    resolve_status: pack.resolve.status, resolve_tier: 'tier' in pack.resolve ? pack.resolve.tier : null,
    sf_job_id: matched?.job.id ?? null, sf_job_number: matched?.job.number ?? null,
    live_facts: liveFacts, live_fetched_at: liveFacts?.fetchedAt ?? null,
    composed_subject: subject, composed_text: text,
    claims: report.claims, unsourced_claims: report.unsourced,
    applied_instruction_ids: instructions.filter(i => i.is_active && (i.channel === 'all' || i.channel === 'email')).map(i => i.id),
    style_example_ids: styleExamples.map(s => s.id),
    answer_library_ids: pack.answers.map(x => x.id),
    charter_version: charter.version, model: composed.model,
    hard_fail_reasons: hardFail,
    confidence, confidence_breakdown: breakdown,
    auto_send_blockers: route.blockers, auto_evaluated_at: new Date().toISOString(),
    status: route.status, approval_path: route.approval_path, send_after: route.send_after,
    ...(route.status === 'queued' ? { sent_text: text } : {}),
    ...(opts.recomposedFrom ? { recomposed_from: opts.recomposedFrom } : {}),
    ...(opts.chatAnswer ? { chat_ask_id: opts.chatAnswer.askId } : {}),
  }).select('id').single()
  if (error) return { outcome: 'error', detail: `reply insert: ${error.message}` }
  const replyId = reply.id as string

  // Source attribution (PRD §12), retained indefinitely.
  const sources = [
    ...pack.facts.filter(f => f.source !== 'answer_library').map(f => ({ reply_id: replyId, source_type: f.source, ref_id: f.refId, ref_label: f.label, fields: { fact_id: f.id, text: f.text, values: f.values } })),
    ...pack.answers.map(x => ({ reply_id: replyId, source_type: 'answer_library', ref_id: x.id, ref_label: x.title, fields: { answer_text: x.answer_text } })),
    ...instructions.filter(i => i.is_active).map(i => ({ reply_id: replyId, source_type: 'instruction', ref_id: i.id, ref_label: i.text.slice(0, 80), fields: {} })),
    ...styleExamples.map(s => ({ reply_id: replyId, source_type: 'style_example', ref_id: s.id, ref_label: (s.inquiry_text ?? s.final_text).slice(0, 80), fields: {} })),
    { reply_id: replyId, source_type: 'charter', ref_id: charter.id, ref_label: `Charter v${charter.version}`, fields: { version: charter.version } },
    { reply_id: replyId, source_type: 'model', ref_id: composed.model, ref_label: composed.model, fields: { prompt_version: settings.prompt_version, classifier: settings.classifier_model, usage: composed.usage } },
    ...thread.map((m, i) => ({ reply_id: replyId, source_type: 'thread_message', ref_id: String(i), ref_label: m.from, fields: { text: m.text.slice(0, 500) } })),
    ...(liveFacts ? [{ reply_id: replyId, source_type: 'sf_job', ref_id: liveFacts.jobId, ref_label: `Live read ${liveFacts.fetchedAt}`, fields: liveFacts as unknown as Record<string, unknown> }] : []),
  ]
  if (sources.length) await db.from('agent_email_sources').insert(sources)

  // Coverage demand log (PRD §9.4): what we could not ground.
  if (composed.couldNotAnswer || pack.resolve.status !== 'matched') {
    await db.from('agent_coverage_log').insert({ message_id: a.messageId, question_type: questionType, missing: composed.missing ?? pack.gaps[0] ?? 'unspecified' })
  }

  if (route.status === 'queued') {
    return { replyId, outcome: 'queued', detail: `auto-send queued · confidence ${Math.round(confidence * 100)}% · sends after ${route.send_after}` }
  }
  // Ask the team in Google Chat when Cassie could not ground the answer (PRD §11).
  // The outcome is recorded as a note on the reply either way: a Chat ask that silently
  // fails to post is indistinguishable from one that was never attempted, and the whole
  // point of the assist is that the partner is not left waiting.
  if (!opts.noChatAsk && !opts.chatAnswer && (composed.couldNotAnswer || pack.resolve.status !== 'matched')) {
    let note: string
    try {
      const { postChatAsk, ASK_SKIP_REASON } = await import('./chat-assist')
      const r = await postChatAsk(db, settings, { replyId, messageId: a.messageId, email: a.email, questionSummary: summary, missing: composed.missing ?? pack.gaps[0] ?? 'the answer to this question', sfJobNumber: matched?.job.number ?? null, sfJobId: matched?.job.id ?? null })
      note = r.posted
        ? 'Asked the team in Google Chat. Their answer there becomes a draft for approval.'
        : `Google Chat ask not sent: ${ASK_SKIP_REASON[r.reason ?? ''] ?? r.reason}.`
    } catch (e) {
      note = `Google Chat ask failed: ${e instanceof Error ? e.message : String(e)}`
      console.error('[cassie]', note)
    }
    const { error: noteErr } = await db.from('agent_email_feedback').insert({ reply_id: replyId, kind: 'note', note })
    if (noteErr) console.error('[cassie] could not record the chat-ask note:', noteErr.message)
  }

  const detail = `draft · confidence ${Math.round(confidence * 100)}%` + (route.blockers.length ? `; held for review: ${route.blockers.join(', ')}` : '')
  return { replyId, outcome: 'drafted', detail }
}

async function loadThreadText(db: SupabaseClient, threadId: string | null, excludeMessageId: string): Promise<Array<{ from: string; text: string }>> {
  if (!threadId) return []
  const { data } = await db.from('agent_email_messages').select('id, from_addr, from_name, snippet, body_text, received_at').eq('gmail_thread_id', threadId).neq('id', excludeMessageId).order('received_at', { ascending: true }).limit(10)
  const { stripQuotedHistory } = await import('./filters')
  return ((data ?? []) as Array<{ id: string; from_addr: string | null; from_name: string | null; body_text: string | null }>).map(m => ({
    from: m.from_name ? `${m.from_name} <${m.from_addr}>` : (m.from_addr ?? 'unknown'),
    text: stripQuotedHistory(m.body_text ?? '').slice(0, 1500),
  }))
}


/** Re-run the composer for an existing reply's message (facts changed before send). The
 *  old reply is marked superseded; the new one routes fresh (and restarts the hold). */
export async function recomposeReply(db: SupabaseClient, settings: AgentSettings, replyId: string, reason: string, extra: Pick<ComposerOptions, 'chatAnswer' | 'noChatAsk'> = {}): Promise<{ outcome: string; detail?: string; replyId?: string }> {
  const { data: old } = await db.from('agent_email_replies').select('id, message_id, gmail_thread_id').eq('id', replyId).single()
  if (!old) return { outcome: 'error', detail: 'reply not found' }
  const { data: m } = await db.from('agent_email_messages').select('*').eq('id', old.message_id as string).single()
  if (!m) return { outcome: 'error', detail: 'message not found' }
  const { stripQuotedHistory } = await import('./filters')
  const { extractIdentifiers } = await import('./identifiers')
  const { loadThreadState } = await import('./pipeline')
  const email = {
    source: (m.delivery_path === 'replay' ? 'replay' : 'gmail') as 'replay' | 'gmail',
    gmailMessageId: m.gmail_message_id as string | null, gmailThreadId: m.gmail_thread_id as string | null,
    internetMessageId: m.internet_message_id as string | null, inReplyTo: m.in_reply_to as string | null, references: (m.references_ids as string[]) ?? [],
    from: { addr: m.from_addr as string, name: m.from_name as string | null },
    to: ((m.to_addrs as string[]) ?? []).map(addr => ({ addr, name: null })), cc: ((m.cc_addrs as string[]) ?? []).map(addr => ({ addr, name: null })),
    subject: (m.subject as string) ?? '', bodyText: (m.body_text as string) ?? '', headers: (m.headers as Record<string, string>) ?? {}, receivedAt: (m.received_at as string) ?? new Date().toISOString(),
  }
  const cleanBody = stripQuotedHistory(email.bodyText)
  const identifiers = extractIdentifiers(cleanBody, { excludeEmails: [email.from.addr, settings.mailbox_address, ...email.to.map(a => a.addr), ...email.cc.map(a => a.addr)] })
  const thread = await loadThreadState(db, email.gmailThreadId)
  await db.from('agent_email_replies').update({ status: 'superseded', cancel_reason: extra.chatAnswer ? 'chat_answered' : 'facts_changed', updated_at: new Date().toISOString() }).eq('id', replyId)
  await db.from('agent_email_feedback').insert({ reply_id: replyId, kind: 'note', note: `Recomposed: ${reason}` })
  return runComposer(db, settings, { messageId: old.message_id as string, email, cleanBody, identifiers, deliveryPath: (m.delivery_path === 'direct' ? 'direct' : 'distribution'), thread }, { recomposedFrom: replyId, ...extra })
}
