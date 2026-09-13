import type { SupabaseClient } from '@supabase/supabase-js'
import { DEFAULT_CHARTER } from './charter.default'

// Shared agent knowledge — the charter, standing instructions, curated answer
// library and style corpus. Every channel composes from THESE rows (PRD §2 forward
// constraint); nothing channel-specific lives here. Admin editing is in
// app/admin/cassie. Read paths seed sensible defaults into an empty table so a
// fresh install has a working charter and a few voice examples on day one.

export interface Charter { id: string; version: number; body: string; note: string | null; is_active: boolean; created_at: string; channel: string }
export interface Instruction { id: string; text: string; channel: string; is_active: boolean; created_at: string; retired_at: string | null }
export interface AnswerEntry {
  id: string; title: string; question_examples: string[]; question_type: string | null; answer_text: string
  audience: string; is_active: boolean; source_chat_ask_id: string | null; created_at: string; updated_at: string
}
export interface StyleExample {
  id: string; source: string; audience: string; question_type: string | null; inquiry_text: string | null
  ai_text: string | null; final_text: string; reply_id: string | null; is_pinned: boolean; is_deleted: boolean; created_at: string
}

// ── Charter ─────────────────────────────────────────────────────────────────

// Charters are per channel (migration 134): 'email' is Cassie's, 'review' is the
// Google-review reply agent's. Every function below defaults to 'email' so the
// existing Cassie callers are unchanged.
const DEFAULT_CHANNEL = 'email'

/** The active charter for a channel, seeding version 1 (from the Cassie spec, or the given seed) if the channel has no rows. */
export async function getActiveCharter(db: SupabaseClient, channel: string = DEFAULT_CHANNEL, seed?: { body: string; note: string }): Promise<Charter> {
  const { data } = await db.from('agent_charter').select('*').eq('channel', channel).eq('is_active', true).maybeSingle()
  if (data) return data as Charter
  const { count } = await db.from('agent_charter').select('id', { count: 'exact', head: true }).eq('channel', channel)
  if ((count ?? 0) === 0) {
    const s = seed ?? { body: DEFAULT_CHARTER, note: 'Seeded from Cassie_Castle_AI_Agent_Spec.md' }
    const { data: seeded, error } = await db.from('agent_charter')
      .insert({ version: 1, body: s.body, note: s.note, is_active: true, channel })
      .select('*').single()
    if (error) throw new Error(`Charter seed failed: ${error.message}`)
    return seeded as Charter
  }
  // Rows exist but none active (someone deactivated) — fall back to the newest.
  const { data: latest } = await db.from('agent_charter').select('*').eq('channel', channel).order('version', { ascending: false }).limit(1).single()
  return latest as Charter
}

export async function listCharterVersions(db: SupabaseClient, channel: string = DEFAULT_CHANNEL): Promise<Charter[]> {
  const { data } = await db.from('agent_charter').select('id, version, note, is_active, created_at, body, channel').eq('channel', channel).order('version', { ascending: false })
  return (data ?? []) as Charter[]
}

/** Save an edit as a NEW version and make it active. Older versions stay for attribution. */
export async function saveCharterVersion(db: SupabaseClient, body: string, note: string | null, userId: string | null, channel: string = DEFAULT_CHANNEL): Promise<Charter> {
  const { data: top } = await db.from('agent_charter').select('version').eq('channel', channel).order('version', { ascending: false }).limit(1).maybeSingle()
  const version = ((top?.version as number | undefined) ?? 0) + 1
  await db.from('agent_charter').update({ is_active: false }).eq('channel', channel).eq('is_active', true)
  const { data, error } = await db.from('agent_charter')
    .insert({ version, body, note, is_active: true, created_by: userId, channel }).select('*').single()
  if (error) throw new Error(error.message)
  return data as Charter
}

/** Activate one version; only its own channel's active row is deactivated. */
export async function activateCharterVersion(db: SupabaseClient, id: string): Promise<void> {
  const { data: row } = await db.from('agent_charter').select('channel').eq('id', id).maybeSingle()
  const channel = (row?.channel as string | undefined) ?? DEFAULT_CHANNEL
  await db.from('agent_charter').update({ is_active: false }).eq('channel', channel).eq('is_active', true)
  const { error } = await db.from('agent_charter').update({ is_active: true }).eq('id', id)
  if (error) throw new Error(error.message)
}

// ── Standing instructions ───────────────────────────────────────────────────

export async function listInstructions(db: SupabaseClient, opts: { includeRetired?: boolean; channel?: string } = {}): Promise<Instruction[]> {
  let q = db.from('agent_instructions').select('*').order('created_at', { ascending: true })
  if (!opts.includeRetired) q = q.eq('is_active', true)
  if (opts.channel) q = q.eq('channel', opts.channel)
  const { data } = await q
  return (data ?? []) as Instruction[]
}

export async function addInstruction(db: SupabaseClient, text: string, channel: string, userId: string | null): Promise<Instruction> {
  const { data, error } = await db.from('agent_instructions').insert({ text: text.trim(), channel, created_by: userId }).select('*').single()
  if (error) throw new Error(error.message)
  return data as Instruction
}

export async function retireInstruction(db: SupabaseClient, id: string, userId: string | null): Promise<void> {
  const { error } = await db.from('agent_instructions').update({ is_active: false, retired_at: new Date().toISOString(), retired_by: userId }).eq('id', id)
  if (error) throw new Error(error.message)
}

export async function reactivateInstruction(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from('agent_instructions').update({ is_active: true, retired_at: null, retired_by: null }).eq('id', id)
  if (error) throw new Error(error.message)
}

// ── Answer library ──────────────────────────────────────────────────────────

export async function listAnswers(db: SupabaseClient, opts: { includeInactive?: boolean } = {}): Promise<AnswerEntry[]> {
  let q = db.from('agent_answer_library').select('*').order('title', { ascending: true })
  if (!opts.includeInactive) q = q.eq('is_active', true)
  const { data } = await q
  return (data ?? []) as AnswerEntry[]
}

export interface AnswerInput { title: string; question_examples: string[]; question_type: string | null; answer_text: string; audience: string }

export async function upsertAnswer(db: SupabaseClient, id: string | null, input: AnswerInput, userId: string | null): Promise<AnswerEntry> {
  const row = {
    title: input.title.trim(),
    question_examples: input.question_examples.map(s => s.trim()).filter(Boolean),
    question_type: input.question_type || null,
    answer_text: input.answer_text.trim(),
    audience: input.audience || 'partner',
    updated_at: new Date().toISOString(),
    updated_by: userId,
  }
  const q = id
    ? db.from('agent_answer_library').update(row).eq('id', id)
    : db.from('agent_answer_library').insert({ ...row, created_by: userId })
  const { data, error } = await q.select('*').single()
  if (error) throw new Error(error.message)
  return data as AnswerEntry
}

export async function setAnswerActive(db: SupabaseClient, id: string, active: boolean, userId: string | null): Promise<void> {
  const { error } = await db.from('agent_answer_library').update({ is_active: active, updated_at: new Date().toISOString(), updated_by: userId }).eq('id', id)
  if (error) throw new Error(error.message)
}

// ── Style corpus ────────────────────────────────────────────────────────────

/** Cassie spec §29 — the four partner exchanges, loaded as the initial corpus (PRD §8). */
export const SEED_STYLE_EXAMPLES: Array<Pick<StyleExample, 'question_type' | 'inquiry_text' | 'final_text'>> = [
  { question_type: 'schedule', inquiry_text: "What's the status of PO 12345?", final_text: 'PO 12345 is scheduled for installation Tuesday, September 8. The material is marked received and the customer has confirmed the appointment.' },
  { question_type: 'material', inquiry_text: "Why hasn't this job been completed?", final_text: "The installation is waiting on a replacement top section. The original section arrived damaged, and the replacement was ordered August 29. I don't see a confirmed delivery date yet." },
  { question_type: 'status', inquiry_text: 'Have you contacted the customer?', final_text: "Yes. We've tried twice — once yesterday afternoon and again this morning — but haven't reached them yet. There's no confirmed appointment at this point." },
  { question_type: 'ship_date', inquiry_text: 'When will Clopay ship the replacement panel?', final_text: "I don't see a confirmed ship date in the information available to me. I don't want to guess. I'll get this in front of our team if we need to confirm it directly with Clopay." },
]

export async function listStyleExamples(db: SupabaseClient, opts: { includeDeleted?: boolean } = {}): Promise<StyleExample[]> {
  // Cassie's corpus only — the review agent's examples live under review_* audiences.
  let q = db.from('agent_style_examples').select('*').not('audience', 'like', 'review_%').order('is_pinned', { ascending: false }).order('created_at', { ascending: false })
  if (!opts.includeDeleted) q = q.eq('is_deleted', false)
  const { data } = await q
  const rows = (data ?? []) as StyleExample[]
  if (rows.length > 0) return rows
  const { count } = await db.from('agent_style_examples').select('id', { count: 'exact', head: true })
  if ((count ?? 0) > 0) return rows
  const { data: seeded } = await db.from('agent_style_examples')
    .insert(SEED_STYLE_EXAMPLES.map(s => ({ ...s, source: 'seed', audience: 'partner', is_pinned: true })))
    .select('*')
  return ((seeded ?? []) as StyleExample[]).sort((a, b) => b.created_at.localeCompare(a.created_at))
}

/** Style examples for specific audiences (e.g. the review agent's bands). No seeding. */
export async function listStyleExamplesByAudience(db: SupabaseClient, audiences: string[]): Promise<StyleExample[]> {
  const { data } = await db.from('agent_style_examples').select('*')
    .in('audience', audiences).eq('is_deleted', false)
    .order('is_pinned', { ascending: false }).order('created_at', { ascending: false })
  return (data ?? []) as StyleExample[]
}

export async function addStyleExample(db: SupabaseClient, input: { inquiry_text: string | null; final_text: string; question_type: string | null; audience?: string; source?: string }, userId: string | null): Promise<StyleExample> {
  const { data, error } = await db.from('agent_style_examples')
    .insert({ source: input.source ?? 'staff', audience: input.audience ?? 'partner', question_type: input.question_type || null, inquiry_text: input.inquiry_text?.trim() || null, final_text: input.final_text.trim(), created_by: userId })
    .select('*').single()
  if (error) throw new Error(error.message)
  return data as StyleExample
}

export async function setStylePinned(db: SupabaseClient, id: string, pinned: boolean): Promise<void> {
  const { error } = await db.from('agent_style_examples').update({ is_pinned: pinned }).eq('id', id)
  if (error) throw new Error(error.message)
}

export async function deleteStyleExample(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from('agent_style_examples').update({ is_deleted: true, is_pinned: false }).eq('id', id)
  if (error) throw new Error(error.message)
}
