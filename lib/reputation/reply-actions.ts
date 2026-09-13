import type { SupabaseClient } from '@supabase/supabase-js'
import { cancelOutbound, enqueueOutbound } from './queue'
import { captureReplyStyleExample } from './knowledge'
import { loadReputationSettings, type ReplyBand, type ReplyOrigin, type ReputationSettings } from './settings'

// What a person (or autopilot) does with a draft (PRD §4.2 step 5, §7 status
// flow): approve / edit-and-approve → scheduled through the queue; skip;
// redraft in place. Human approvals become style examples; autopilot ones do not.

interface ReplyRow {
  id: string; google_review_id: string; band: ReplyBand; origin: ReplyOrigin; status: string
  draft_text: string; final_text: string | null; approved_by: string | null
}

async function getReply(db: SupabaseClient, id: string): Promise<ReplyRow> {
  const { data, error } = await db.from('review_replies').select('id, google_review_id, band, origin, status, draft_text, final_text, approved_by').eq('id', id).single()
  if (error || !data) throw new Error('Reply not found')
  return data as ReplyRow
}

export type ApproveResult = { ok: true; scheduledFor: string; pushReasons: string[]; edited: boolean } | { ok: false; error: string }

/** Approve (optionally with edits) and put the reply on the send calendar. userId null = autopilot. */
export async function approveAndSchedule(db: SupabaseClient, replyId: string, input: { text: string; userId: string | null; earliestAt?: Date }, settings?: ReputationSettings): Promise<ApproveResult> {
  const r = await getReply(db, replyId)
  if (!['draft', 'approved', 'failed'].includes(r.status)) return { ok: false, error: `This reply is already ${r.status}.` }
  const finalText = input.text.trim()
  if (!finalText) return { ok: false, error: 'The reply text is empty.' }
  const edited = finalText !== r.draft_text.trim()
  const now = new Date()
  const nowIso = now.toISOString()
  const { error } = await db.from('review_replies').update({
    status: 'approved', final_text: finalText, approved_by: input.userId, approved_at: nowIso, error: null, updated_at: nowIso,
  }).eq('id', replyId)
  if (error) return { ok: false, error: error.message }

  if (input.userId) {
    const { data: review } = await db.from('google_reviews').select('star_rating, comment').eq('id', r.google_review_id).maybeSingle()
    const rv = review as { star_rating: number; comment: string | null } | null
    await captureReplyStyleExample(db, {
      reviewId: r.google_review_id, band: r.band, starRating: rv?.star_rating ?? (r.band === 'positive' ? 5 : 2), reviewText: rv?.comment ?? null,
      draftText: r.draft_text, finalText, edited, userId: input.userId,
    }).catch(() => { /* learning is best-effort */ })
  }

  const s = settings ?? await loadReputationSettings(db)
  const q = await enqueueOutbound(db, s, { kind: 'review_reply', refId: replyId, band: r.band, origin: r.origin, earliestAt: input.earliestAt ?? now }, now)
  if (!q.ok) {
    await db.from('review_replies').update({ status: 'failed', error: 'No send slot within 14 days — check the working window and caps.', updated_at: nowIso }).eq('id', replyId)
    return { ok: false, error: 'No send slot within 14 days. Check the working window and daily caps in Settings.' }
  }
  await db.from('review_replies').update({ status: 'scheduled', scheduled_for: q.scheduledFor.toISOString(), push_reasons: q.pushReasons, updated_at: nowIso }).eq('id', replyId)
  return { ok: true, scheduledFor: q.scheduledFor.toISOString(), pushReasons: q.pushReasons, edited }
}

/** Skip: nothing is sent; any queued send is cancelled. */
export async function skipReply(db: SupabaseClient, replyId: string, userId: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await getReply(db, replyId)
  if (!['draft', 'approved', 'scheduled', 'failed'].includes(r.status)) return { ok: false, error: `This reply is already ${r.status}.` }
  await cancelOutbound(db, 'review_reply', replyId, 'skipped by ' + (userId ?? 'system'))
  const { error } = await db.from('review_replies').update({ status: 'skipped', scheduled_for: null, updated_at: new Date().toISOString() }).eq('id', replyId)
  return error ? { ok: false, error: error.message } : { ok: true }
}

/** Redraft in place (a person asked, optionally with a note). Stays a draft; earlier text is kept in guardrail_notes. */
export async function redraftReply(db: SupabaseClient, replyId: string, note: string | null): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const r = await getReply(db, replyId)
  if (r.status !== 'draft' && r.status !== 'failed') return { ok: false, error: `Only drafts can be redrafted (this one is ${r.status}).` }
  const { loadDraftDeps, draftWithGuardrails, guardrailContextFor, renderReplyBody, REVIEW_SELECT } = await import('./reply-drafter')
  const { buildReplyContext } = await import('./reply-context')
  const { data: review } = await db.from('google_reviews').select(REVIEW_SELECT).eq('id', r.google_review_id).maybeSingle()
  if (!review) return { ok: false, error: 'Review not found' }
  const deps = await loadDraftDeps(db)
  const rv = review as Parameters<typeof buildReplyContext>[1] & { ai_mentioned_names?: string[] | null }
  const ctx = await buildReplyContext(db, rv, deps.roster)
  const out = await draftWithGuardrails(ctx, deps, guardrailContextFor(ctx, deps, rv), { reviewerNote: note })
  if (!out) return { ok: false, error: 'ANTHROPIC_API_KEY is not set, so nothing can be drafted.' }
  const text = renderReplyBody(out.draft.body, deps.settings.reply_signature)
  const { data: prevRow } = await db.from('review_replies').select('guardrail_notes').eq('id', replyId).maybeSingle()
  const prevNotes = ((prevRow as { guardrail_notes: Record<string, unknown> } | null)?.guardrail_notes ?? {}) as { previous_drafts?: string[] }
  const notes = { ...out.notes, previous_drafts: [...(prevNotes.previous_drafts ?? []), r.draft_text, ...(out.notes.previous_drafts as string[])], redraft_note: note }
  const { error } = await db.from('review_replies').update({
    status: 'draft', draft_text: text, final_text: null, guardrail_notes: notes, model: out.draft.model, style_example_ids: out.draft.styleIds, error: null, updated_at: new Date().toISOString(),
  }).eq('id', replyId)
  return error ? { ok: false, error: error.message } : { ok: true, text }
}

// ── Stats for the autopilot switches ───────────────────────────────────────

export interface ApprovalStatRow { band: ReplyBand; approved_by: string | null; approved_at: string | null; draft_text: string; final_text: string | null }
export interface BandStats { unedited: number; edited: number; auto: number }
export interface ApprovalStats { positive: { d30: BandStats; d90: BandStats }; negative: { d30: BandStats; d90: BandStats } }

/** Pure: per band, how many approvals in the last 30 / 90 days were human-unedited, human-edited, or autopilot. */
export function approvalStats(rows: ApprovalStatRow[], now = new Date()): ApprovalStats {
  const empty = (): BandStats => ({ unedited: 0, edited: 0, auto: 0 })
  const out: ApprovalStats = { positive: { d30: empty(), d90: empty() }, negative: { d30: empty(), d90: empty() } }
  const t30 = now.getTime() - 30 * 86_400_000, t90 = now.getTime() - 90 * 86_400_000
  for (const r of rows) {
    if (!r.approved_at) continue
    const at = new Date(r.approved_at).getTime()
    if (at < t90 || at > now.getTime()) continue
    const key: keyof BandStats = r.approved_by === null ? 'auto' : (r.final_text ?? '').trim() !== r.draft_text.trim() ? 'edited' : 'unedited'
    out[r.band].d90[key]++
    if (at >= t30) out[r.band].d30[key]++
  }
  return out
}

export async function loadApprovalStatRows(db: SupabaseClient, now = new Date()): Promise<ApprovalStatRow[]> {
  const since = new Date(now.getTime() - 90 * 86_400_000).toISOString()
  const { data } = await db.from('review_replies').select('band, approved_by, approved_at, draft_text, final_text').gte('approved_at', since).limit(5000)
  return (data ?? []) as ApprovalStatRow[]
}

export async function loadNeedsApprovalCount(db: SupabaseClient): Promise<number> {
  const { count } = await db.from('review_replies').select('id', { count: 'exact', head: true }).eq('status', 'draft')
  return count ?? 0
}
