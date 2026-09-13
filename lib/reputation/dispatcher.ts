import type { SupabaseClient } from '@supabase/supabase-js'
import { loadReputationSettings, type OutboundKind, type ReputationSettings } from './settings'
import { PROFILE_KINDS, replanOutbound, type QueueRow } from './queue'

// The per-minute sender (PRD §4.5). Sends whatever is due under the stagger
// rules, one profile-visible item per run so a backlog after a pause drips out
// instead of bursting. Overlap-safe through an optimistic per-row claim (same
// pattern as app/api/cron/send-notifications) plus a sweep for rows stuck in
// 'sending' when a function was killed mid-send.

export type QueueRowLike = QueueRow

export type HandlerResult =
  | { ok: true }
  | { ok: false; error: string; retry: boolean; cancel?: boolean; optOut?: boolean }

export type Handler = (db: SupabaseClient, row: QueueRow, settings: ReputationSettings) => Promise<HandlerResult>
export type Handlers = Partial<Record<OutboundKind, Handler>>

export interface DispatchReport {
  skipped?: string
  sent: number; failed: number; retried: number; cancelled: number; swept: number
  errors: string[]
}

const STUCK_MS = 10 * 60_000
const MAX_ATTEMPTS = 3

export async function runDispatch(db: SupabaseClient, handlers: Handlers, opts: { now?: Date; max?: number } = {}): Promise<DispatchReport> {
  const now = opts.now ?? new Date()
  const nowIso = now.toISOString()
  const report: DispatchReport = { sent: 0, failed: 0, retried: 0, cancelled: 0, swept: 0, errors: [] }
  const settings = await loadReputationSettings(db)
  if (settings.sends_paused) return { ...report, skipped: 'paused' }

  // 1. Sweep rows stuck in 'sending'.
  const { data: stuck } = await db.from('outbound_queue').select('id, kind, ref_id, attempts')
    .eq('status', 'sending').lt('claimed_at', new Date(now.getTime() - STUCK_MS).toISOString()).limit(50)
  for (const s of (stuck ?? []) as Array<{ id: string; kind: OutboundKind; ref_id: string; attempts: number }>) {
    if (s.attempts < MAX_ATTEMPTS) {
      await db.from('outbound_queue').update({ status: 'queued', claimed_at: null, updated_at: nowIso }).eq('id', s.id)
    } else {
      await db.from('outbound_queue').update({ status: 'failed', error: 'stuck in sending', updated_at: nowIso }).eq('id', s.id)
      await propagateFailure(db, s.kind, s.ref_id, 'stuck in sending')
    }
    report.swept++
  }

  // 2. Due rows, by priority then planned time.
  const { data: due } = await db.from('outbound_queue').select('*')
    .eq('status', 'queued').lte('scheduled_for', nowIso)
    .order('priority', { ascending: true }).order('scheduled_for', { ascending: true })
    .limit(opts.max ?? 10)
  const rows = (due ?? []) as QueueRow[]
  if (!rows.length) return report

  // 3. Profile-visible kinds: at most one per run, and only if the last one is ≥ min gap ago.
  const { data: lastProfile } = await db.from('outbound_queue').select('sent_at')
    .in('kind', PROFILE_KINDS).eq('status', 'sent').order('sent_at', { ascending: false }).limit(1).maybeSingle()
  const lastProfileAt = (lastProfile as { sent_at: string } | null)?.sent_at ? new Date((lastProfile as { sent_at: string }).sent_at).getTime() : 0
  let profileAllowed = now.getTime() - lastProfileAt >= settings.min_gap_minutes * 60_000

  for (const row of rows) {
    const isProfile = PROFILE_KINDS.includes(row.kind)
    if (isProfile && !profileAllowed) continue

    // 4. Optimistic claim.
    const { data: claimed } = await db.from('outbound_queue')
      .update({ status: 'sending', claimed_at: nowIso, attempts: row.attempts + 1, updated_at: nowIso })
      .eq('id', row.id).eq('status', 'queued').select('id')
    if (!claimed || claimed.length === 0) continue
    const attempts = row.attempts + 1

    const handler = handlers[row.kind]
    let result: HandlerResult
    try {
      result = handler ? await handler(db, row, settings) : { ok: false, error: `${row.kind} is not implemented yet`, retry: false }
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : String(e), retry: true }
    }

    if (result.ok) {
      await db.from('outbound_queue').update({ status: 'sent', sent_at: nowIso, error: null, updated_at: nowIso }).eq('id', row.id)
      report.sent++
      if (isProfile) profileAllowed = false
      continue
    }

    report.errors.push(`${row.kind} ${row.ref_id}: ${result.error}`)
    if (result.cancel) {
      await db.from('outbound_queue').update({ status: 'cancelled', error: result.error.slice(0, 500), updated_at: nowIso }).eq('id', row.id)
      report.cancelled++
      continue
    }
    if (result.retry && attempts < MAX_ATTEMPTS) {
      const earliest = new Date(now.getTime() + settings.min_gap_minutes * 60_000)
      const re = await replanOutbound(db, settings, { ...row, attempts }, earliest, 'retry', now)
      if (re.ok) { await db.from('outbound_queue').update({ error: result.error.slice(0, 500) }).eq('id', row.id); report.retried++; continue }
    }
    await db.from('outbound_queue').update({ status: 'failed', error: result.error.slice(0, 500), updated_at: nowIso }).eq('id', row.id)
    await propagateFailure(db, row.kind, row.ref_id, result.error)
    report.failed++
  }
  return report
}

async function propagateFailure(db: SupabaseClient, kind: OutboundKind, refId: string, error: string): Promise<void> {
  if (kind === 'review_reply') {
    const { failReviewReply } = await import('./reply-send')
    await failReviewReply(db, refId, error)
  }
}
