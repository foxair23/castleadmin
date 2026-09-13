import type { SupabaseClient } from '@supabase/supabase-js'
import { postReviewReply } from '@/lib/google-reviews/gbp-client'
import { autopilotOn, type ReplyBand, type ReputationSettings } from './settings'
import type { HandlerResult, QueueRowLike } from './dispatcher'

// Sends one approved review reply to Google (called by the dispatcher when its
// queue row comes due). Re-checks the autopilot switch for autopilot approvals
// so flipping a switch off after approval still stops the send.

export async function sendReviewReply(db: SupabaseClient, row: QueueRowLike, settings: ReputationSettings): Promise<HandlerResult> {
  const { data: reply } = await db.from('review_replies')
    .select('id, google_review_id, band, status, final_text, approved_by')
    .eq('id', row.ref_id).maybeSingle()
  const r = reply as { id: string; google_review_id: string; band: ReplyBand; status: string; final_text: string | null; approved_by: string | null } | null
  if (!r) return { ok: false, error: 'reply row missing', retry: false, cancel: true }
  if (r.status !== 'scheduled') return { ok: false, error: `reply is ${r.status}`, retry: false, cancel: true }
  if (!r.final_text?.trim()) return { ok: false, error: 'reply has no text', retry: false, cancel: true }

  const now = new Date().toISOString()
  if (r.approved_by === null && !autopilotOn(settings, r.band)) {
    // Approved by autopilot, but the switch is off now → back to the queue for a person.
    await db.from('review_replies').update({ status: 'draft', approved_at: null, scheduled_for: null, push_reasons: [], updated_at: now }).eq('id', r.id)
    return { ok: false, error: 'autopilot switched off before send', retry: false, cancel: true }
  }

  const { data: review } = await db.from('google_reviews').select('google_review_id').eq('id', r.google_review_id).maybeSingle()
  const googleReviewId = (review as { google_review_id: string } | null)?.google_review_id
  if (!googleReviewId) return { ok: false, error: 'google review missing', retry: false, cancel: true }

  const res = await postReviewReply(googleReviewId, r.final_text)
  if (!res.ok) {
    // 4xx other than 429 is not going to fix itself.
    const retry = res.status === 0 || res.status === 429 || res.status >= 500
    return { ok: false, error: res.error, retry }
  }
  await db.from('review_replies').update({ status: 'posted', sent_at: now, error: null, updated_at: now }).eq('id', r.id)
  await db.from('google_reviews').update({
    reply_text: r.final_text, reply_updated_at: res.replyUpdatedAt ?? now, reply_source: 'agent',
  }).eq('id', r.google_review_id)
  return { ok: true }
}

/** Marks the reply failed when the dispatcher gives up on its queue row. */
export async function failReviewReply(db: SupabaseClient, replyId: string, error: string): Promise<void> {
  await db.from('review_replies').update({ status: 'failed', error: error.slice(0, 500), updated_at: new Date().toISOString() }).eq('id', replyId)
}
