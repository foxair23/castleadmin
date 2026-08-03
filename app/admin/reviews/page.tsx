import { createClient as createAdminClient } from '@supabase/supabase-js'
import ReviewsTabs from './ReviewsTabs'
import { loadCsatSettings } from '@/lib/csat/config'
import { getCsatRows } from '@/lib/csat/metrics'

export const metadata = { title: 'Reviews' }

export default async function ReviewsPage() {
  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Google-reviews KPIs (existing tab).
  const { data: kpiRows } = await db
    .from('google_reviews')
    .select('star_rating')
    .is('deleted_at', null)
  const all = kpiRows ?? []
  const total = all.length
  const avgRating = total > 0 ? all.reduce((s, r) => s + r.star_rating, 0) / total : null
  const fiveStars = all.filter(r => r.star_rating === 5).length
  const oneStar = all.filter(r => r.star_rating === 1).length

  const { data: lastRun } = await db
    .from('review_sync_runs')
    .select('status, ended_at, reviews_new, reviews_seen, errors_json')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  // Active techs — shared by the Google-review credited-tech picker and the CSAT filters.
  const { data: techRows } = await db
    .from('profiles')
    .select('id, full_name')
    .eq('role', 'technician')
    .eq('is_active', true)
    .order('full_name')
  const techs = (techRows ?? []).map(t => ({ id: t.id as string, full_name: (t.full_name as string | null) ?? '' }))

  // CSAT sub-tab data.
  const [csatSettings, csatRows] = await Promise.all([loadCsatSettings(), getCsatRows()])

  return (
    <ReviewsTabs
      csat={{ settings: csatSettings, rows: csatRows }}
      google={{
        kpi: { total, avgRating, fiveStars, oneStar },
        lastRun: lastRun as { status: string; ended_at: string | null; reviews_new: number | null; reviews_seen: number | null; errors_json: string[] | null } | null,
      }}
      techs={techs}
    />
  )
}
