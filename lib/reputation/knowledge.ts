import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getActiveCharter, listInstructions, listStyleExamplesByAudience,
  type Charter, type Instruction, type StyleExample,
} from '@/lib/agent/knowledge'
import { DEFAULT_REVIEW_CHARTER } from './charter.default'
import { bandFor, type ReplyBand } from './settings'

// The reply agent's knowledge: its own charter, standing instructions and style
// examples, stored in Cassie's tables under channel 'review' / audiences
// 'review_positive' | 'review_negative'. Nothing here reads Cassie's own rows.

export const REVIEW_CHANNEL = 'review'
export const audienceFor = (band: ReplyBand): string => `review_${band}`
export const REVIEW_AUDIENCES = ['review_positive', 'review_negative']

export async function getReviewCharter(db: SupabaseClient): Promise<Charter> {
  return getActiveCharter(db, REVIEW_CHANNEL, { body: DEFAULT_REVIEW_CHARTER, note: 'Seeded from the Reputation Engine PRD' })
}

/** Only rules written for reviews. Cassie's 'all' rules are about partner email and must not leak in. */
export async function listReviewInstructions(db: SupabaseClient, opts: { includeRetired?: boolean } = {}): Promise<Instruction[]> {
  return listInstructions(db, { ...opts, channel: REVIEW_CHANNEL })
}

export async function listReviewStyleExamples(db: SupabaseClient, band?: ReplyBand): Promise<StyleExample[]> {
  return listStyleExamplesByAudience(db, band ? [audienceFor(band)] : REVIEW_AUDIENCES)
}

/**
 * One-time import: every reply Castle already had on Google becomes a style example
 * (source 'pre_existing'), keyed by google_reviews.id so re-runs never duplicate.
 * Returns the number of examples added.
 */
export async function importPreExistingReplies(db: SupabaseClient): Promise<number> {
  const { data: reviews } = await db.from('google_reviews')
    .select('id, star_rating, comment, reply_text')
    .eq('reply_source', 'pre_existing').not('reply_text', 'is', null).is('deleted_at', null)
    .limit(2000)
  const rows = (reviews ?? []) as Array<{ id: string; star_rating: number; comment: string | null; reply_text: string }>
  if (!rows.length) return 0
  const { data: done } = await db.from('agent_style_examples').select('google_review_id').in('google_review_id', rows.map(r => r.id))
  const seen = new Set(((done ?? []) as Array<{ google_review_id: string }>).map(d => d.google_review_id))
  const inserts = rows.filter(r => !seen.has(r.id) && r.reply_text.trim()).map(r => ({
    source: 'pre_existing', audience: audienceFor(bandFor(r.star_rating)), question_type: String(r.star_rating),
    inquiry_text: r.comment?.trim() || null, ai_text: null, final_text: r.reply_text.trim(), google_review_id: r.id,
  }))
  if (!inserts.length) return 0
  const { error } = await db.from('agent_style_examples').insert(inserts)
  if (error) throw new Error(`pre-existing reply import failed: ${error.message}`)
  return inserts.length
}

/** A human approve/edit becomes a style example for that band (autopilot approvals do not). */
export async function captureReplyStyleExample(db: SupabaseClient, input: {
  reviewId: string; band: ReplyBand; starRating: number; reviewText: string | null
  draftText: string; finalText: string; edited: boolean; userId: string
}): Promise<void> {
  await db.from('agent_style_examples').insert({
    source: input.edited ? 'human_edit' : 'human_approved',
    audience: audienceFor(input.band),
    question_type: String(input.starRating),
    inquiry_text: input.reviewText?.trim() || null,
    ai_text: input.draftText,
    final_text: input.finalText,
    google_review_id: input.reviewId,
    created_by: input.userId,
  })
}
