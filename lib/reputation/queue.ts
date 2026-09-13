import type { SupabaseClient } from '@supabase/supabase-js'
import { capFor, type OutboundKind, type ReplyBand, type ReplyOrigin, type ReputationSettings, type WorkingWindow } from './settings'
import { makeRng, planSlot, type ExistingSend, type PushReason } from './slot-planner'
import { ptDateKey, ptWallToUtc } from './pt-time'

// The outbound queue (PRD §4.5): one table for everything the reputation
// engine sends — review replies, profile posts (Phase 2) and CSAT reminders.
// Rows are planned here and sent by the dispatcher (dispatcher.ts).

// Priorities: new negative replies first, then new positive, then CSAT
// reminders, then profile posts, then backlog replies.
export function priorityFor(kind: OutboundKind, band: ReplyBand | null, origin: ReplyOrigin | null): number {
  if (kind === 'review_reply') {
    if (origin === 'backlog') return 5
    return band === 'negative' ? 1 : 2
  }
  if (kind === 'csat_reminder') return 3
  return 4 // gbp_post
}

/** Kinds that show up on the public profile and must look like one person working. */
export const PROFILE_KINDS: OutboundKind[] = ['review_reply', 'gbp_post']

export interface QueueRow {
  id: string; kind: OutboundKind; ref_id: string; location_id: string | null; priority: number
  origin: ReplyOrigin | null; band: ReplyBand | null; payload: Record<string, unknown>
  earliest_at: string; scheduled_for: string; claimed_at: string | null; sent_at: string | null
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled'; attempts: number
  push_reasons: string[]; error: string | null; created_at: string; updated_at: string
}

/** Everything already on the calendar: queued/sending rows by planned time, plus today's sent rows by actual time. */
export async function loadPlanningContext(db: SupabaseClient, kinds: OutboundKind[], now = new Date()): Promise<ExistingSend[]> {
  const dayStart = ptWallToUtc(ptDateKey(now), 0).toISOString()
  const [{ data: live }, { data: sent }] = await Promise.all([
    db.from('outbound_queue').select('kind, origin, scheduled_for').in('kind', kinds).in('status', ['queued', 'sending']).limit(2000),
    db.from('outbound_queue').select('kind, origin, sent_at').in('kind', kinds).eq('status', 'sent').gte('sent_at', dayStart).limit(2000),
  ])
  const out: ExistingSend[] = []
  for (const r of (live ?? []) as Array<{ kind: string; origin: string | null; scheduled_for: string }>) out.push({ at: new Date(r.scheduled_for), kind: r.kind, origin: r.origin })
  for (const r of (sent ?? []) as Array<{ kind: string; origin: string | null; sent_at: string }>) out.push({ at: new Date(r.sent_at), kind: r.kind, origin: r.origin })
  return out
}

export interface EnqueueItem {
  kind: OutboundKind
  refId: string
  band?: ReplyBand | null
  origin?: ReplyOrigin | null
  earliestAt: Date
  payload?: Record<string, unknown>
  /** Override the working window (CSAT reminders use the texting window). */
  window?: WorkingWindow
  locationId?: string | null
}

export type EnqueueResult =
  | { ok: true; queueId: string; scheduledFor: Date; pushReasons: PushReason[] }
  | { ok: false; reason: 'no_slot' }

/** Rules for how a kind is spaced: profile-visible sends share one calendar; reminders only avoid each other lightly. */
function spacingFor(settings: ReputationSettings, kind: OutboundKind): { kinds: OutboundKind[]; minGap: number; maxGap: number; skip: number } {
  if (kind === 'csat_reminder') return { kinds: ['csat_reminder'], minGap: 2, maxGap: 6, skip: 0 }
  return { kinds: PROFILE_KINDS, minGap: settings.min_gap_minutes, maxGap: settings.max_gap_minutes, skip: settings.skip_hour_ratio }
}

/** Plan a send time for one item and insert it. */
export async function enqueueOutbound(db: SupabaseClient, settings: ReputationSettings, item: EnqueueItem, now = new Date()): Promise<EnqueueResult> {
  const origin = item.origin ?? null
  const band = item.band ?? null
  const spacing = spacingFor(settings, item.kind)
  const existing = await loadPlanningContext(db, spacing.kinds, now)
  const plan = planSlot({
    now, earliestAt: item.earliestAt,
    window: item.window ?? settings.working_window,
    minGapMin: spacing.minGap, maxGapMin: spacing.maxGap, skipHourRatio: spacing.skip,
    cap: capFor(settings, item.kind, origin),
    capBucket: e => e.kind === item.kind && (item.kind !== 'review_reply' || e.origin === origin),
    existing,
    rng: makeRng(`${item.kind}:${item.refId}:${now.getTime()}`),
  })
  if (!plan.ok) return plan
  const nowIso = now.toISOString()
  const { data, error } = await db.from('outbound_queue').insert({
    kind: item.kind, ref_id: item.refId, location_id: item.locationId ?? process.env.GOOGLE_BUSINESS_LOCATION_ID ?? null,
    priority: priorityFor(item.kind, band, origin), origin, band, payload: item.payload ?? {},
    earliest_at: item.earliestAt.toISOString(), scheduled_for: plan.scheduledFor.toISOString(),
    status: 'queued', push_reasons: plan.pushReasons, created_at: nowIso, updated_at: nowIso,
  }).select('id').single()
  if (error) throw new Error(`enqueue failed: ${error.message}`)
  return { ok: true, queueId: (data as { id: string }).id, scheduledFor: plan.scheduledFor, pushReasons: plan.pushReasons }
}

/** Re-plan an existing row (after a failed attempt) from a new earliest time. */
export async function replanOutbound(db: SupabaseClient, settings: ReputationSettings, row: QueueRow, earliestAt: Date, extraReason: string, now = new Date()): Promise<EnqueueResult> {
  const spacing = spacingFor(settings, row.kind)
  const existing = await loadPlanningContext(db, spacing.kinds, now)
  const plan = planSlot({
    now, earliestAt,
    window: settings.working_window,
    minGapMin: spacing.minGap, maxGapMin: spacing.maxGap, skipHourRatio: spacing.skip,
    cap: capFor(settings, row.kind, row.origin),
    capBucket: e => e.kind === row.kind && (row.kind !== 'review_reply' || e.origin === row.origin),
    existing,
    rng: makeRng(`${row.id}:${row.attempts}:${now.getTime()}`),
  })
  if (!plan.ok) return plan
  const reasons = [...new Set([...(row.push_reasons ?? []), ...plan.pushReasons, extraReason])]
  await db.from('outbound_queue').update({
    status: 'queued', scheduled_for: plan.scheduledFor.toISOString(), claimed_at: null,
    push_reasons: reasons, updated_at: now.toISOString(),
  }).eq('id', row.id)
  return { ok: true, queueId: row.id, scheduledFor: plan.scheduledFor, pushReasons: plan.pushReasons }
}

export async function findLiveQueueRow(db: SupabaseClient, kind: OutboundKind, refId: string, payloadMatch?: Record<string, unknown>): Promise<QueueRow | null> {
  let q = db.from('outbound_queue').select('*').eq('kind', kind).eq('ref_id', refId).in('status', ['queued', 'sending'])
  if (payloadMatch) q = q.contains('payload', payloadMatch)
  const { data } = await q.order('created_at', { ascending: false }).limit(1).maybeSingle()
  return (data as QueueRow | null) ?? null
}

/** Cancel every live queue row for a reference (e.g. a reply that was skipped). */
export async function cancelOutbound(db: SupabaseClient, kind: OutboundKind, refId: string, reason: string): Promise<number> {
  const { data } = await db.from('outbound_queue')
    .update({ status: 'cancelled', error: reason, updated_at: new Date().toISOString() })
    .eq('kind', kind).eq('ref_id', refId).in('status', ['queued', 'sending']).select('id')
  return (data ?? []).length
}
