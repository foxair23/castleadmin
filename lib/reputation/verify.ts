import type { SupabaseClient } from '@supabase/supabase-js'

// After a reply is posted, the next sync reads it back from Google (PRD §4.6).
// Same text → verified. A different reply on Google means a person changed it
// there; a missing one shortly after posting is just propagation delay.

const norm = (s: string) => s
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
  .replace(/\s+/g, ' ').trim()

/** Pure: does Google's reply text match what we sent, ignoring whitespace and smart punctuation? */
export function repliesMatch(google: string | null | undefined, ours: string | null | undefined): boolean {
  if (!google || !ours) return false
  return norm(google) === norm(ours)
}

export interface VerifyReport { verified: number; changedOnGoogle: number; notVisibleYet: number }

/** Reconcile posted replies against what the sync just read for these reviews. */
export async function verifyPostedReplies(db: SupabaseClient, reviews: Array<{ id: string; reply_text: string | null }>, now = new Date()): Promise<VerifyReport> {
  const report: VerifyReport = { verified: 0, changedOnGoogle: 0, notVisibleYet: 0 }
  if (!reviews.length) return report
  const byReview = new Map(reviews.map(r => [r.id, r.reply_text]))
  const { data } = await db.from('review_replies').select('id, google_review_id, final_text, sent_at')
    .eq('status', 'posted').in('google_review_id', [...byReview.keys()])
  const nowIso = now.toISOString()
  for (const r of (data ?? []) as Array<{ id: string; google_review_id: string; final_text: string | null; sent_at: string | null }>) {
    const google = byReview.get(r.google_review_id) ?? null
    if (repliesMatch(google, r.final_text)) {
      await db.from('review_replies').update({ status: 'verified', verified_at: nowIso, error: null, updated_at: nowIso }).eq('id', r.id)
      await db.from('google_reviews').update({ reply_source: 'agent' }).eq('id', r.google_review_id)
      report.verified++
    } else if (google) {
      await db.from('review_replies').update({ error: 'The reply on Google differs from what we sent (edited there).', updated_at: nowIso }).eq('id', r.id)
      await db.from('google_reviews').update({ reply_source: 'manual' }).eq('id', r.google_review_id)
      report.changedOnGoogle++
    } else if (r.sent_at && now.getTime() - new Date(r.sent_at).getTime() > 2 * 3_600_000) {
      await db.from('review_replies').update({ error: 'Reply not visible on Google yet.', updated_at: nowIso }).eq('id', r.id)
      report.notVisibleYet++
    }
  }
  return report
}
