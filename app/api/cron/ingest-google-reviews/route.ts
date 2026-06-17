import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isConfigured, fetchAllReviews } from '@/lib/google-reviews/gbp-client'
import { MOCK_REVIEWS } from '@/lib/google-reviews/mock-data'

export const maxDuration = 60

// Patterns that indicate an anonymous / no-name reviewer (spec §6.3)
const ANONYMOUS_PATTERNS = [
  /^a google user$/i,
  /^google user$/i,
  /^anonymous$/i,
]

function isAnonymous(name: string | null): boolean {
  if (!name || !name.trim()) return true
  return ANONYMOUS_PATTERNS.some(p => p.test(name.trim()))
}

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = db()

  // Record sync run start
  const { data: run } = await supabase
    .from('review_sync_runs')
    .insert({ status: 'running' })
    .select('id')
    .single()
  const runId = (run as { id: string } | null)?.id

  const errors: string[] = []
  let reviewsSeen  = 0
  let reviewsNew   = 0
  let reviewsUpdated = 0

  try {
    // ── Fetch reviews — live API or mock ────────────────────────────────────
    let reviews = await (isConfigured()
      ? fetchAllReviews()
      : Promise.resolve(MOCK_REVIEWS)
    )

    // When using mock data, only seed if table is empty (avoids duplicating on
    // every cron run during development)
    if (!isConfigured()) {
      const { count } = await supabase
        .from('google_reviews')
        .select('id', { count: 'exact', head: true })
      if ((count ?? 0) > 0) {
        await supabase
          .from('review_sync_runs')
          .update({ status: 'completed', ended_at: new Date().toISOString(), reviews_seen: 0, reviews_new: 0, reviews_updated: 0 })
          .eq('id', runId!)
        return NextResponse.json({ ok: true, skipped: true, reason: 'mock data already seeded' })
      }
    }

    reviewsSeen = reviews.length

    // ── Upsert each review individually so one failure doesn't block others ─
    for (const r of reviews) {
      try {
        const matchStatus = isAnonymous(r.reviewerName) ? 'anonymous' : 'pending_review'

        // Check if already exists
        const { data: existing } = await supabase
          .from('google_reviews')
          .select('id, updated_at_google')
          .eq('google_review_id', r.googleReviewId)
          .maybeSingle()

        if (!existing) {
          await supabase.from('google_reviews').insert({
            google_review_id:    r.googleReviewId,
            reviewer_name:       r.reviewerName,
            star_rating:         r.starRating,
            comment:             r.comment,
            created_at_google:   r.createdAtGoogle,
            updated_at_google:   r.updatedAtGoogle,
            reply_text:          r.replyText,
            reply_updated_at:    r.replyUpdatedAt,
            match_status:        matchStatus,
            raw_payload:         r.rawPayload,
            last_synced_at:      new Date().toISOString(),
          })
          reviewsNew++
        } else {
          // Update if the reviewer edited or we have a stale reply
          const prevUpdated = (existing as { updated_at_google: string }).updated_at_google
          const changed = new Date(r.updatedAtGoogle) > new Date(prevUpdated)
          const updates: Record<string, unknown> = { last_synced_at: new Date().toISOString() }
          if (changed) {
            updates.updated_at_google = r.updatedAtGoogle
            updates.reply_text        = r.replyText
            updates.reply_updated_at  = r.replyUpdatedAt
            updates.raw_payload       = r.rawPayload
            // Only reset match_status if the reviewer name or create time changed
            // (spec §5.2 — don't re-run matching on mere text edits)
          }
          await supabase
            .from('google_reviews')
            .update(updates)
            .eq('google_review_id', r.googleReviewId)
          if (changed) reviewsUpdated++
        }
      } catch (err) {
        errors.push(`${r.googleReviewId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    await supabase
      .from('review_sync_runs')
      .update({
        status:          errors.length > 0 && reviewsNew + reviewsUpdated === 0 ? 'failed' : 'completed',
        ended_at:        new Date().toISOString(),
        reviews_seen:    reviewsSeen,
        reviews_new:     reviewsNew,
        reviews_updated: reviewsUpdated,
        errors_json:     errors.length > 0 ? errors : null,
      })
      .eq('id', runId!)

    return NextResponse.json({ ok: true, reviewsSeen, reviewsNew, reviewsUpdated, errors: errors.length })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[ingest-google-reviews] fatal:', msg)
    if (runId) {
      await supabase
        .from('review_sync_runs')
        .update({ status: 'failed', ended_at: new Date().toISOString(), errors_json: [msg] })
        .eq('id', runId)
    }
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
