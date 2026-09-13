import type { SupabaseClient } from '@supabase/supabase-js'
import { agentDb } from '@/lib/agent/settings'

// Reputation Engine settings — one row (reputation_settings id=1). Defaults here
// MUST match migration 134 so a missing row (or a new column) behaves the same as
// a freshly seeded one. Safety defaults: both autopilot switches off.

export type WeekdayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
export const WEEKDAYS: WeekdayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] // index = JS getDay()

/** Minutes-of-day PT [open, close) per weekday; null = closed that day. */
export type WorkingWindow = Record<WeekdayKey, [number, number] | null>

export type ReplyBand = 'positive' | 'negative'
export type OutboundKind = 'review_reply' | 'gbp_post' | 'csat_reminder'
export type ReplyOrigin = 'new' | 'backlog'

export interface ReputationSettings {
  autopilot_positive: boolean
  autopilot_negative: boolean
  sends_paused: boolean
  reply_signature: string

  reply_delay_min_hours: number
  reply_delay_max_hours: number
  working_window: WorkingWindow
  min_gap_minutes: number
  max_gap_minutes: number
  skip_hour_ratio: number
  cap_new_replies: number
  cap_backlog_replies: number
  cap_posts: number

  ingest_interval_minutes: number
  draft_since: string
  pre_existing_imported_at: string | null
  prompt_version: number

  updated_at: string | null
  updated_by: string | null
}

export const DEFAULT_WORKING_WINDOW: WorkingWindow = {
  mon: [460, 1100], tue: [460, 1100], wed: [460, 1100], thu: [460, 1100], fri: [460, 1100],
  sat: [510, 850],
  sun: null,
}

export const REPUTATION_DEFAULTS: ReputationSettings = {
  autopilot_positive: false,
  autopilot_negative: false,
  sends_paused: false,
  reply_signature: 'Castle team',

  reply_delay_min_hours: 1,
  reply_delay_max_hours: 6,
  working_window: DEFAULT_WORKING_WINDOW,
  min_gap_minutes: 20,
  max_gap_minutes: 90,
  skip_hour_ratio: 0.25,
  cap_new_replies: 8,
  cap_backlog_replies: 3,
  cap_posts: 1,

  ingest_interval_minutes: 30,
  draft_since: '1970-01-01T00:00:00.000Z',
  pre_existing_imported_at: null,
  prompt_version: 1,

  updated_at: null,
  updated_by: null,
}

const NULLABLE = ['pre_existing_imported_at', 'updated_at', 'updated_by'] as const

/** Merge a DB row over the defaults; null columns fall back so new columns are safe. */
export function mergeReputationSettings(row: Partial<Record<keyof ReputationSettings, unknown>> | null | undefined): ReputationSettings {
  const out: Record<string, unknown> = { ...REPUTATION_DEFAULTS }
  if (!row) return out as unknown as ReputationSettings
  for (const k of Object.keys(REPUTATION_DEFAULTS) as (keyof ReputationSettings)[]) {
    const v = row[k]
    if (v === undefined || v === null) continue
    // numeric() columns arrive as strings from PostgREST
    out[k] = typeof REPUTATION_DEFAULTS[k] === 'number' ? Number(v) : v
  }
  out.working_window = normalizeWindow(out.working_window)
  for (const k of NULLABLE) if (k in row) out[k] = row[k] ?? null
  return out as unknown as ReputationSettings
}

/** Accepts a loosely shaped window (from JSON or a form) and returns a valid one. */
export function normalizeWindow(raw: unknown): WorkingWindow {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out = { ...DEFAULT_WORKING_WINDOW }
  for (const day of WEEKDAYS) {
    if (!(day in src)) continue
    const v = src[day]
    if (v == null) { out[day] = null; continue }
    if (Array.isArray(v) && v.length === 2) {
      const open = Math.max(0, Math.min(1440, Math.round(Number(v[0]))))
      const close = Math.max(0, Math.min(1440, Math.round(Number(v[1]))))
      out[day] = Number.isFinite(open) && Number.isFinite(close) && close > open ? [open, close] : null
    }
  }
  return out
}

export async function loadReputationSettings(db: SupabaseClient = agentDb()): Promise<ReputationSettings> {
  const { data } = await db.from('reputation_settings').select('*').eq('id', 1).maybeSingle()
  return mergeReputationSettings(data as Partial<ReputationSettings> | null)
}

/** 4–5 stars are the positive band, 1–3 the negative band (PRD §4.3). */
export function bandFor(starRating: number): ReplyBand {
  return starRating >= 4 ? 'positive' : 'negative'
}

export function autopilotOn(settings: ReputationSettings, band: ReplyBand): boolean {
  return band === 'positive' ? settings.autopilot_positive : settings.autopilot_negative
}

/** Daily cap for a queue item, or null when the kind is uncapped (reminders). */
export function capFor(settings: ReputationSettings, kind: OutboundKind, origin: ReplyOrigin | null): number | null {
  if (kind === 'gbp_post') return settings.cap_posts
  if (kind === 'review_reply') return origin === 'backlog' ? settings.cap_backlog_replies : settings.cap_new_replies
  return null
}
