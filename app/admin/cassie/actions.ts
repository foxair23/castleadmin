'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { agentDb, type AgentSettings } from '@/lib/agent/settings'
import {
  saveCharterVersion, activateCharterVersion,
  addInstruction, retireInstruction, reactivateInstruction,
  upsertAnswer, setAnswerActive, type AnswerInput,
  addStyleExample, setStylePinned, deleteStyleExample,
} from '@/lib/agent/knowledge'

async function assertAdmin(): Promise<string> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') redirect('/login')
  return user.id
}

const PATH = '/admin/cassie'

// ── Settings ────────────────────────────────────────────────────────────────
// Only these keys are writable from the admin UI. Gmail health/cursor columns and
// the model/prompt versions are managed by code.
const EDITABLE: ReadonlyArray<keyof AgentSettings> = [
  'processing_enabled', 'auto_respond_enabled',
  'mailbox_address', 'from_display_name', 'reply_to_email', 'cc_office', 'signature_text', 'escape_hatch_text',
  'allowlist_domains', 'allowlist_addresses', 'blocklist_addresses',
  'confidence_threshold', 'auto_question_types', 'auto_match_tiers', 'hold_minutes', 'staleness_minutes', 'closed_window_days',
  'confusion_threshold', 'confusion_min_sample', 'chat_space_name', 'chat_timeout_minutes', 'chat_max_asks_per_hour',
  'escalation_extra_emails', 'paused_tiers',
]

export async function saveAgentSettings(patch: Partial<AgentSettings>): Promise<void> {
  const userId = await assertAdmin()
  // Phase-2 gate (PRD §14): auto-send may not be enabled until a regression baseline exists.
  if (patch.auto_respond_enabled === true) {
    const { count } = await agentDb().from('agent_regression_runs').select('id', { count: 'exact', head: true }).gte('cases', 30)
    if (!count) throw new Error('Auto-Respond stays off until the regression set has at least 30 cases and has been run once (Cassie → Dashboard).')
  }
  const row: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: userId }
  for (const k of EDITABLE) if (k in patch) row[k] = patch[k]
  const db = agentDb()
  const { error } = await db.from('agent_settings').update(row).eq('id', 1)
  if (error) throw new Error(error.message)
  // Panic button semantics (PRD §6.3): turning Auto-Respond off pulls back anything Cassie
  // queued on her own that has not sent yet. Human-approved sends are unaffected.
  if (patch.auto_respond_enabled === false || patch.processing_enabled === false) {
    const { data: pulled } = await db.from('agent_email_replies').update({ status: 'draft', send_after: null, approval_path: null, cancel_reason: 'auto_switched_off', updated_at: new Date().toISOString() })
      .eq('status', 'queued').eq('approval_path', 'auto').select('id')
    for (const r of pulled ?? []) await db.from('agent_email_feedback').insert({ reply_id: r.id, kind: 'note', note: 'Auto-Respond turned off; returned to review before sending.', user_id: userId })
  }
  revalidatePath(PATH)
}

// ── Charter ─────────────────────────────────────────────────────────────────
export async function saveCharter(body: string, note: string): Promise<void> {
  const userId = await assertAdmin()
  if (body.trim().length < 200) throw new Error('The charter looks too short to be complete.')
  await saveCharterVersion(agentDb(), body, note.trim() || null, userId)
  revalidatePath(PATH)
}
export async function activateCharter(id: string): Promise<void> {
  await assertAdmin(); await activateCharterVersion(agentDb(), id); revalidatePath(PATH)
}

// ── Instructions ────────────────────────────────────────────────────────────
export async function createInstruction(text: string, channel: 'all' | 'email' | 'phone'): Promise<void> {
  const userId = await assertAdmin()
  if (!text.trim()) throw new Error('Instruction text is required.')
  await addInstruction(agentDb(), text, channel, userId); revalidatePath(PATH)
}
export async function retireInstructionAction(id: string): Promise<void> {
  const userId = await assertAdmin(); await retireInstruction(agentDb(), id, userId); revalidatePath(PATH)
}
export async function reactivateInstructionAction(id: string): Promise<void> {
  await assertAdmin(); await reactivateInstruction(agentDb(), id); revalidatePath(PATH)
}

// ── Answer library ──────────────────────────────────────────────────────────
export async function saveAnswer(id: string | null, input: AnswerInput): Promise<void> {
  const userId = await assertAdmin()
  if (!input.title.trim() || !input.answer_text.trim()) throw new Error('Title and answer are required.')
  await upsertAnswer(agentDb(), id, input, userId); revalidatePath(PATH)
}
export async function setAnswerActiveAction(id: string, active: boolean): Promise<void> {
  const userId = await assertAdmin(); await setAnswerActive(agentDb(), id, active, userId); revalidatePath(PATH)
}

// ── Style corpus ────────────────────────────────────────────────────────────
export async function createStyleExample(input: { inquiry_text: string; final_text: string; question_type: string }): Promise<void> {
  const userId = await assertAdmin()
  if (!input.final_text.trim()) throw new Error('The reply text is required.')
  await addStyleExample(agentDb(), { inquiry_text: input.inquiry_text, final_text: input.final_text, question_type: input.question_type || null }, userId)
  revalidatePath(PATH)
}
export async function pinStyleExample(id: string, pinned: boolean): Promise<void> {
  await assertAdmin(); await setStylePinned(agentDb(), id, pinned); revalidatePath(PATH)
}
export async function removeStyleExample(id: string): Promise<void> {
  await assertAdmin(); await deleteStyleExample(agentDb(), id); revalidatePath(PATH)
}

// ── Replay (testing without a mailbox) ──────────────────────────────────────
// Runs a pasted email through the exact pipeline Gmail messages will use. The
// Processing switch is bypassed for a replay so filters can be exercised before
// launch; every other rule applies. Nothing is ever sent from a replay.
export async function replayPastedEmail(input: { from: string; to: string; cc: string; subject: string; body: string; autoReply: boolean; threadId: string }): Promise<{ outcome: string; detail?: string }> {
  await assertAdmin()
  const { ingestEmail, replayEmail } = await import('@/lib/agent/email/pipeline')
  const { makeComposerStage } = await import('@/lib/agent/email/composer-stage')
  const { loadAgentSettings } = await import('@/lib/agent/settings')
  const db = agentDb()
  // Replays exercise the pipeline only: processing forced on, auto-send forced off.
  const settings = { ...(await loadAgentSettings(db)), processing_enabled: true, auto_respond_enabled: false }
  const email = replayEmail({
    from: input.from, to: input.to, cc: input.cc, subject: input.subject, body: input.body,
    headers: input.autoReply ? { 'Auto-Submitted': 'auto-replied' } : {},
    threadId: input.threadId.trim() ? `replay:${input.threadId.trim()}` : null,
  })
  const res = await ingestEmail(db, email, { settings, composer: makeComposerStage() })
  revalidatePath(PATH)
  return { outcome: res.outcome, detail: res.detail }
}

// ── Review panel (PRD §12) ──────────────────────────────────────────────────
async function reviewer(): Promise<{ userId: string; userName: string | null }> {
  const userId = await assertAdmin()
  const { data } = await agentDb().from('profiles').select('full_name, email').eq('id', userId).maybeSingle()
  return { userId, userName: (data?.full_name as string | null) ?? (data?.email as string | null) ?? null }
}
/** Server actions cannot throw usefully: in production Next.js replaces the message with
 *  "An error occurred in the Server Components render", so a reviewer who clicks Reject on
 *  a reply that was superseded a minute ago learns nothing. Return the message instead. */
export type ActionResult = { error?: string }
async function attempt<T extends object = Record<never, never>>(fn: () => Promise<T | void>): Promise<T & ActionResult> {
  try { const r = await fn(); revalidatePath(PATH); return (r ?? {}) as T & ActionResult }
  catch (e) { return { error: e instanceof Error ? e.message : String(e) } as T & ActionResult }
}

export async function approveReplyAction(id: string, text: string, note: string): Promise<ActionResult> {
  const { userId } = await reviewer()
  const { approveReply } = await import('@/lib/agent/email/review')
  return attempt(() => approveReply(agentDb(), id, { text, note: note || null, userId }))
}
export async function rejectReplyAction(id: string, note: string): Promise<ActionResult> {
  const { userId } = await reviewer()
  const { rejectReply } = await import('@/lib/agent/email/review')
  return attempt(() => rejectReply(agentDb(), id, { note: note || null, userId }))
}
export async function escalateReplyAction(id: string, note: string): Promise<{ notified?: number } & ActionResult> {
  const { userId, userName } = await reviewer()
  const { escalateReply } = await import('@/lib/agent/email/review')
  const { loadAgentSettings } = await import('@/lib/agent/settings')
  const db = agentDb()
  return attempt(async () => escalateReply(db, id, { note: note || null, userId, userName, settings: await loadAgentSettings(db) }))
}
/** The reviewer tells Cassie something and she writes the draft again from it — the same
 *  path a Google Chat answer takes, with the reviewer as the human. The old draft is
 *  superseded, the note is kept as feedback so the learning loop sees it, and the new
 *  draft still needs a person to approve: a human-fed reply never auto-sends. */
export async function reviseReplyAction(id: string, instruction: string): Promise<ActionResult & { replyId?: string; learned?: string[] }> {
  const text = instruction.trim()
  if (!text) return { error: 'Tell Cassie what to change first.' }
  return attempt(async () => {
    const { userId, userName } = await reviewer()
    const db = agentDb()
    const { data: r } = await db.from('agent_email_replies').select('status, question_summary, composed_text, sf_job_number').eq('id', id).single()
    if (r?.status !== 'draft') throw new Error(`This reply is already ${r?.status ?? 'gone'}; it cannot be revised.`)
    await db.from('agent_email_feedback').insert({ reply_id: id, kind: 'revise', note: text, user_id: userId })
    const { recomposeReply } = await import('@/lib/agent/email/composer-stage')
    const { loadAgentSettings } = await import('@/lib/agent/settings')
    const { digestTeamMessage, saveLearnedInstructions } = await import('@/lib/agent/email/teach')
    const settings = await loadAgentSettings(db)
    // A reviewer's note can teach as well as correct: rules in it become standing instructions.
    let learned: string[] = []
    let answer = text
    try {
      const d = await digestTeamMessage(settings, { partnerQuestion: r.question_summary as string | null, askedFor: null, jobNumber: r.sf_job_number as string | null, currentDraft: r.composed_text as string | null, conversation: [], latest: { who: userName ?? 'Reviewer', text } })
      learned = await saveLearnedInstructions(db, d.instructions, `review:${id}`)
      if (d.facts.length) answer = [...d.facts, ...(d.instructions.length ? [`Apply: ${d.instructions.join(' ')}`] : [])].join('\n')
    } catch (e) { console.error('[cassie] revise digest', e) }
    const rc = await recomposeReply(db, settings, id, `revised in review by ${userName ?? 'a reviewer'}`, {
      chatAnswer: { text: answer, responder: userName ?? 'Reviewer', channel: 'review' }, noChatAsk: true,
    })
    if (rc.outcome === 'error' || !rc.replyId) throw new Error(rc.detail ?? 'Cassie could not write the revised draft.')
    revalidatePath(PATH)
    return { replyId: rc.replyId, learned }
  })
}

/** "Ask the team about this" on a draft: Cassie takes the reviewer's note to the Chat space
 *  and owns the conversation from there — back and forth as needed — until she has what she
 *  needs to draft again. The draft stays; the answer supersedes it through Review. */
export async function askTeamAction(id: string, note: string): Promise<ActionResult & { askId?: string }> {
  const text = note.trim()
  if (!text) return { error: 'Say what you want the team to weigh in on first.' }
  return attempt(async () => {
    const { userId, userName } = await reviewer()
    const db = agentDb()
    const { data: r } = await db.from('agent_email_replies').select('id, message_id, status, question_summary, sf_job_id, sf_job_number').eq('id', id).single()
    if (r?.status !== 'draft') throw new Error(`This reply is already ${r?.status ?? 'gone'}.`)
    const { data: m } = await db.from('agent_email_messages').select('*').eq('id', r.message_id as string).single()
    if (!m) throw new Error('The inbound message is gone.')
    const { postChatAsk, ASK_SKIP_REASON } = await import('@/lib/agent/email/chat-assist')
    const { loadAgentSettings } = await import('@/lib/agent/settings')
    const email = {
      source: 'gmail' as const, gmailMessageId: m.gmail_message_id as string | null, gmailThreadId: m.gmail_thread_id as string | null,
      internetMessageId: m.internet_message_id as string | null, inReplyTo: m.in_reply_to as string | null, references: (m.references_ids as string[]) ?? [],
      from: { addr: m.from_addr as string, name: m.from_name as string | null }, to: [], cc: [], subject: (m.subject as string) ?? '', bodyText: (m.body_text as string) ?? '', headers: {}, receivedAt: (m.received_at as string) ?? new Date().toISOString(),
    }
    const res = await postChatAsk(db, await loadAgentSettings(db), {
      replyId: id, messageId: r.message_id as string, email, questionSummary: (r.question_summary as string | null) ?? (m.subject as string) ?? 'the partner\'s question',
      missing: text, sfJobNumber: r.sf_job_number as string | null, sfJobId: r.sf_job_id as string | null, askedBy: userName ?? 'A reviewer',
    })
    if (!res.posted) throw new Error(`Could not ask in Chat: ${ASK_SKIP_REASON[res.reason ?? ''] ?? res.reason}`)
    await db.from('agent_email_feedback').insert({ reply_id: id, kind: 'note', note: `Asked the team in Google Chat (${userName ?? 'reviewer'}): ${text}`, user_id: userId })
    revalidatePath(PATH)
    return { askId: res.askId }
  })
}
export async function replyFeedbackAction(id: string, kind: 'post_send' | 'confused' | 'note', note: string): Promise<ActionResult> {
  const { userId } = await reviewer()
  const { addReplyFeedback } = await import('@/lib/agent/email/review')
  return attempt(() => addReplyFeedback(agentDb(), id, { kind, note, userId }))
}
export async function unqueueReplyAction(id: string): Promise<ActionResult> {
  const { userId } = await reviewer()
  const { cancelQueuedReply } = await import('@/lib/agent/email/review')
  return attempt(() => cancelQueuedReply(agentDb(), id, userId))
}

/** Remove a replayed email and everything composed from it. Replays are test input pasted by
 *  an admin, so they can simply go; a real partner email is a record and is never deleted
 *  from here — close it with Reject or Escalate instead. */
export async function deleteReplayAction(messageId: string): Promise<ActionResult> {
  await assertAdmin()
  return attempt(async () => {
    const db = agentDb()
    const { data: m } = await db.from('agent_email_messages').select('id, delivery_path').eq('id', messageId).maybeSingle()
    if (!m) throw new Error('That message is already gone.')
    if (m.delivery_path !== 'replay') throw new Error('Only replayed emails can be deleted. This one came from the mailbox — reject or escalate it instead.')
    const { error } = await db.from('agent_email_messages').delete().eq('id', messageId)
    if (error) throw new Error(error.message)
  })
}

/** Run a mailbox message through the pipeline again, as if it had just arrived: the message
 *  is re-fetched from Gmail (so it gets today's relay unwrapping and filters), its old record
 *  is removed, and the result — a draft in Review, or a drop — replaces it. For messages
 *  filed wrongly before a fix, like partner mail recorded as "Castle staff wrote". */
export async function reprocessMessageAction(messageId: string): Promise<ActionResult & { outcome?: string; detail?: string }> {
  await assertAdmin()
  return attempt(async () => {
    const db = agentDb()
    const { data: m } = await db.from('agent_email_messages').select('id, delivery_path, gmail_message_id, outcome').eq('id', messageId).maybeSingle()
    if (!m) throw new Error('That message is gone.')
    if (m.delivery_path === 'replay' || !m.gmail_message_id) throw new Error('Only messages from the mailbox can be reprocessed — replay a pasted email instead.')
    if (m.outcome === 'accepted' || m.outcome === 'composed' || m.outcome === 'sent') throw new Error('This message was already answered or drafted — reject or revise that draft instead.')
    const { count: replies } = await db.from('agent_email_replies').select('id', { count: 'exact', head: true }).eq('message_id', messageId)
    if (replies) throw new Error('This message already has a draft — work from the Review tab.')
    const { loadGmailCredential, getAccessToken, fetchMessageById } = await import('@/lib/agent/email/gmail')
    const { ingestEmail } = await import('@/lib/agent/email/pipeline')
    const { makeComposerStage } = await import('@/lib/agent/email/composer-stage')
    const { loadAgentSettings } = await import('@/lib/agent/settings')
    const cred = await loadGmailCredential(db)
    if (!cred) throw new Error('The mailbox is not connected.')
    const email = await fetchMessageById(await getAccessToken(cred), m.gmail_message_id as string)
    const { error } = await db.from('agent_email_messages').delete().eq('id', messageId)
    if (error) throw new Error(error.message)
    // A deliberate act by an admin: the processing switch does not gate it; auto-send does.
    const settings = { ...(await loadAgentSettings(db)), processing_enabled: true }
    const res = await ingestEmail(db, email, { settings, composer: makeComposerStage() })
    revalidatePath(PATH)
    return { outcome: res.outcome, detail: res.detail }
  })
}

// ── Regression set (PRD §10, §14) ───────────────────────────────────────────
export async function saveAsRegressionCase(replyId: string): Promise<ActionResult> {
  const { userId } = await reviewer()
  const { createCaseFromReply } = await import('@/lib/agent/email/regression')
  return attempt(() => createCaseFromReply(agentDb(), replyId, userId))
}
export async function runRegressionAction(): Promise<{ cases: number; passed: number; mean_score: number | null }> {
  const { userId } = await reviewer()
  const { runRegression } = await import('@/lib/agent/email/regression')
  const { loadAgentSettings } = await import('@/lib/agent/settings')
  const db = agentDb()
  const run = await runRegression(db, await loadAgentSettings(db), { userId })
  revalidatePath(PATH)
  return { cases: run.cases, passed: run.passed, mean_score: run.mean_score }
}
export async function setRegressionCaseActive(id: string, active: boolean): Promise<void> {
  await assertAdmin(); await agentDb().from('agent_regression_cases').update({ is_active: active }).eq('id', id); revalidatePath(PATH)
}
export async function deleteRegressionCase(id: string): Promise<void> {
  await assertAdmin(); await agentDb().from('agent_regression_cases').delete().eq('id', id); revalidatePath(PATH)
}

/** Post a test message to the configured Chat space and report the result verbatim. */
export async function testChatConnectionAction(): Promise<{ ok: boolean; message: string }> {
  await assertAdmin()
  const { testChatConnection } = await import('@/lib/agent/chat/google-chat')
  const { loadAgentSettings } = await import('@/lib/agent/settings')
  const s = await loadAgentSettings(agentDb())
  return testChatConnection(s.chat_space_name ?? '')
}

/** Sign with a pasted key file, to tell a bad key file apart from a mangled env var.
 *  Nothing is stored: the pasted text lives only for the duration of this call. */
export async function checkKeyFileAction(pasted: string): Promise<{ ok: boolean; message: string }> {
  await assertAdmin()
  const { checkKeyFile } = await import('@/lib/agent/chat/google-chat')
  return checkKeyFile(pasted)
}
