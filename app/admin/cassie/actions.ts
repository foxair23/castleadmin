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
  'escalation_extra_emails',
]

export async function saveAgentSettings(patch: Partial<AgentSettings>): Promise<void> {
  const userId = await assertAdmin()
  const row: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: userId }
  for (const k of EDITABLE) if (k in patch) row[k] = patch[k]
  const { error } = await agentDb().from('agent_settings').update(row).eq('id', 1)
  if (error) throw new Error(error.message)
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
  const { loadAgentSettings } = await import('@/lib/agent/settings')
  const db = agentDb()
  const settings = { ...(await loadAgentSettings(db)), processing_enabled: true }
  const email = replayEmail({
    from: input.from, to: input.to, cc: input.cc, subject: input.subject, body: input.body,
    headers: input.autoReply ? { 'Auto-Submitted': 'auto-replied' } : {},
    threadId: input.threadId.trim() ? `replay:${input.threadId.trim()}` : null,
  })
  const res = await ingestEmail(db, email, { settings })
  revalidatePath(PATH)
  return { outcome: res.outcome, detail: res.detail }
}
