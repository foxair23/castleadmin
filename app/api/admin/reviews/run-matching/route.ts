import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { isConfigured, fetchAllReviews } from '@/lib/google-reviews/gbp-client'
import { MOCK_REVIEWS } from '@/lib/google-reviews/mock-data'
import { runMatchingPass } from '@/lib/google-reviews/matcher'

export const maxDuration = 60

const ANONYMOUS_PATTERNS = [/^a google user$/i, /^google user$/i, /^anonymous$/i]
function isAnonymous(name: string | null): boolean {
  if (!name || !name.trim()) return true
  return ANONYMOUS_PATTERNS.some(p => p.test(name.trim()))
}

function db() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await db().from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') return null
  return user
}

export async function POST() {
  if (!await requireAdmin()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = db()
  let reviewsNew = 0
  let reviewsUpdated = 0

  // ── Ingest ────────────────────────────────────────────────────────────────
  try {
    const reviews = await (isConfigured() ? fetchAllReviews() : Promise.resolve(MOCK_REVIEWS))

    for (const r of reviews) {
      const matchStatus = isAnonymous(r.reviewerName) ? 'anonymous' : 'pending_review'

      const { data: existing } = await supabase
        .from('google_reviews')
        .select('id, updated_at_google')
        .eq('google_review_id', r.googleReviewId)
        .maybeSingle()

      if (!existing) {
        await supabase.from('google_reviews').insert({
          google_review_id:  r.googleReviewId,
          reviewer_name:     r.reviewerName,
          star_rating:       r.starRating,
          comment:           r.comment,
          created_at_google: r.createdAtGoogle,
          updated_at_google: r.updatedAtGoogle,
          reply_text:        r.replyText,
          reply_updated_at:  r.replyUpdatedAt,
          match_status:      matchStatus,
          raw_payload:       r.rawPayload,
          last_synced_at:    new Date().toISOString(),
        })
        reviewsNew++
      } else {
        const changed = new Date(r.updatedAtGoogle) > new Date((existing as { updated_at_google: string }).updated_at_google)
        const updates: Record<string, unknown> = { last_synced_at: new Date().toISOString() }
        if (changed) {
          updates.updated_at_google = r.updatedAtGoogle
          updates.reply_text        = r.replyText
          updates.reply_updated_at  = r.replyUpdatedAt
          updates.raw_payload       = r.rawPayload
          reviewsUpdated++
        }
        await supabase.from('google_reviews').update(updates).eq('google_review_id', r.googleReviewId)
      }
    }
  } catch (err) {
    return NextResponse.json({ error: `Ingest failed: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 })
  }

  // ── Match ─────────────────────────────────────────────────────────────────
  let matchResult
  try {
    matchResult = await runMatchingPass()
  } catch (err) {
    return NextResponse.json(
      { error: `Matching failed: ${err instanceof Error ? err.message : String(err)}`, reviewsNew, reviewsUpdated },
      { status: 500 },
    )
  }

  return NextResponse.json({ ok: true, reviewsNew, reviewsUpdated, ...matchResult })
}
