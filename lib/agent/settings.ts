import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { officeEmail } from '@/lib/config/domains'

// Cassie settings — one row (agent_settings id=1), read by every channel. Defaults
// here MUST match migration 115 so a missing row (or a new column) behaves the same
// as a freshly seeded one. Safety defaults: processing off, auto-respond off.

export type QuestionType =
  | 'schedule' | 'completion' | 'tech' | 'status'          // the auto-send focus area
  | 'ship_date' | 'pricing' | 'warranty' | 'reschedule' | 'complaint' | 'material' | 'multi' | 'other'

export type MatchTier = 'po' | 'name'

export interface AgentSettings {
  processing_enabled: boolean
  auto_respond_enabled: boolean

  mailbox_address: string
  from_display_name: string
  reply_to_email: string | null
  cc_office: boolean
  signature_text: string
  escape_hatch_text: string

  allowlist_domains: string[]
  allowlist_addresses: string[]
  blocklist_addresses: string[]

  confidence_threshold: number
  auto_question_types: QuestionType[]
  auto_match_tiers: MatchTier[]
  hold_minutes: number
  staleness_minutes: number
  closed_window_days: number
  paused_tiers: Record<string, { since: string; rate: number }>

  confusion_threshold: number
  confusion_min_sample: number

  chat_space_name: string | null
  chat_timeout_minutes: number
  chat_max_asks_per_hour: number

  escalation_extra_emails: string[]

  composer_model: string
  classifier_model: string
  prompt_version: number

  gmail_last_ok_at: string | null
  gmail_last_error: string | null
  gmail_last_error_at: string | null
  gmail_history_id: string | null

  updated_at: string | null
}

export const AGENT_DEFAULTS: AgentSettings = {
  processing_enabled: false,
  auto_respond_enabled: false,

  mailbox_address: 'cassie@castlegarage.com',
  from_display_name: 'Cassie (Castle AI Agent)',
  reply_to_email: null,
  cc_office: true,
  signature_text: "This answer was composed by Cassie, Castle Garage Doors & Gates' AI Agent.",
  escape_hatch_text: 'Reply to this email and a member of our team will pick it up.',

  allowlist_domains: [],
  allowlist_addresses: [],
  blocklist_addresses: [],

  confidence_threshold: 0.9,
  auto_question_types: ['schedule', 'completion', 'tech', 'status'],
  auto_match_tiers: ['po'],
  hold_minutes: 12,
  staleness_minutes: 5,
  closed_window_days: 60,
  paused_tiers: {},

  confusion_threshold: 0.2,
  confusion_min_sample: 10,

  chat_space_name: null,
  chat_timeout_minutes: 30,
  chat_max_asks_per_hour: 6,

  escalation_extra_emails: [],

  composer_model: 'claude-sonnet-5',
  classifier_model: 'claude-haiku-4-5',
  prompt_version: 1,

  gmail_last_ok_at: null,
  gmail_last_error: null,
  gmail_last_error_at: null,
  gmail_history_id: null,

  updated_at: null,
}

export function agentDb(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

/** Merge a DB row over the defaults; null columns fall back so new columns are safe. */
export function mergeSettings(row: Partial<Record<keyof AgentSettings, unknown>> | null | undefined): AgentSettings {
  const out: Record<string, unknown> = { ...AGENT_DEFAULTS }
  if (!row) return out as unknown as AgentSettings
  for (const k of Object.keys(AGENT_DEFAULTS) as (keyof AgentSettings)[]) {
    const v = row[k]
    if (v === undefined || v === null) continue
    // numeric() columns arrive as strings from PostgREST
    out[k] = typeof AGENT_DEFAULTS[k] === 'number' ? Number(v) : v
  }
  // Nullable-by-design columns keep an explicit null from the row.
  for (const k of ['reply_to_email', 'chat_space_name', 'gmail_last_ok_at', 'gmail_last_error', 'gmail_last_error_at', 'gmail_history_id', 'updated_at'] as const) {
    if (k in row) out[k] = row[k] ?? null
  }
  return out as unknown as AgentSettings
}

export async function loadAgentSettings(db: SupabaseClient = agentDb()): Promise<AgentSettings> {
  const { data } = await db.from('agent_settings').select('*').eq('id', 1).maybeSingle()
  return mergeSettings(data as Partial<AgentSettings> | null)
}

/** Reply-To for partner mail: the configured override, else the office inbox. */
export function agentReplyTo(s: AgentSettings): string {
  return s.reply_to_email?.trim() || officeEmail()
}

/** Is this sender inside the perimeter? Deterministic, case-insensitive. Empty allowlist → nobody. */
export function isAllowlisted(s: AgentSettings, fromAddr: string | null | undefined): boolean {
  const addr = (fromAddr ?? '').trim().toLowerCase()
  if (!addr) return false
  if (s.blocklist_addresses.some(b => b.trim().toLowerCase() === addr)) return false
  if (s.allowlist_addresses.some(a => a.trim().toLowerCase() === addr)) return true
  const domain = addr.split('@')[1] ?? ''
  return s.allowlist_domains.some(d => {
    const dd = d.trim().toLowerCase().replace(/^@/, '')
    return dd !== '' && (domain === dd || domain.endsWith('.' + dd))
  })
}

/** Auto-send eligibility for a (question type, tier) pair — before confidence is even computed. */
export function isAutoEligible(s: AgentSettings, questionType: QuestionType, tier: MatchTier): { ok: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (!s.auto_respond_enabled) reasons.push('auto_off')
  if (!s.auto_question_types.includes(questionType)) reasons.push('type_not_auto')
  if (!s.auto_match_tiers.includes(tier)) reasons.push('tier_not_auto')
  if (s.paused_tiers[`${questionType}:${tier}`]) reasons.push('tier_paused')
  return { ok: reasons.length === 0, reasons }
}
