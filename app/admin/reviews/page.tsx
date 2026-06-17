import { createClient as createAdminClient } from '@supabase/supabase-js'
import ReviewsClient from './ReviewsClient'

export const metadata = { title: 'Reviews' }

export default async function ReviewsPage() {
  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Quick KPIs — aggregate across all non-deleted reviews
  const { data: kpiRows } = await db
    .from('google_reviews')
    .select('star_rating')
    .is('deleted_at', null)

  const all = kpiRows ?? []
  const total = all.length
  const avgRating = total > 0 ? all.reduce((s, r) => s + r.star_rating, 0) / total : null
  const fiveStars = all.filter(r => r.star_rating === 5).length
  const oneStar   = all.filter(r => r.star_rating === 1).length

  // Last sync run
  const { data: lastRun } = await db
    .from('review_sync_runs')
    .select('status, ended_at, reviews_new, reviews_seen')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return (
    <ReviewsClient
      kpi={{ total, avgRating, fiveStars, oneStar }}
      lastRun={lastRun as { status: string; ended_at: string | null; reviews_new: number | null; reviews_seen: number | null } | null}
    />
  )
}
