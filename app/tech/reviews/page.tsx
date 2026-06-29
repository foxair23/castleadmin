import { createClient as createAdminClient } from '@supabase/supabase-js'

export const metadata = { title: 'Reviews' }

interface Review {
  id: string
  reviewer_name: string | null
  star_rating: number
  comment: string | null
  created_at_google: string
  reply_text: string | null
  matched_job_id: string | null
}

function Stars({ n }: { n: number }) {
  return (
    <span className="text-amber-500" title={`${n} star${n === 1 ? '' : 's'}`}>
      {'★'.repeat(n)}<span className="text-gray-300">{'★'.repeat(5 - n)}</span>
    </span>
  )
}

function fmtDate(s: string): string {
  return new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// Read-only reviews list for technicians. Reps can read customer feedback; all
// management (sync/match) stays on the admin Reviews page.
export default async function TechReviewsPage() {
  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )

  const { data: reviewRows } = await db
    .from('google_reviews')
    .select('id, reviewer_name, star_rating, comment, created_at_google, reply_text, matched_job_id')
    .is('deleted_at', null)
    .order('created_at_google', { ascending: false })
    .limit(100)
  const reviews = (reviewRows ?? []) as Review[]

  // Resolve the assigned tech for matched reviews.
  const jobIds = [...new Set(reviews.map(r => r.matched_job_id).filter(Boolean) as string[])]
  const techByJob = new Map<string, string>()
  if (jobIds.length > 0) {
    const { data: jt } = await db
      .from('sf_job_techs')
      .select('job_id, tech_first_name, tech_last_name')
      .in('job_id', jobIds)
    for (const t of jt ?? []) {
      const name = [t.tech_first_name, t.tech_last_name].filter(Boolean).join(' ')
      if (name && !techByJob.has(t.job_id)) techByJob.set(t.job_id, name)
    }
  }

  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 mb-1">Reviews</h1>
      <p className="text-sm text-gray-500 mb-4">Recent customer reviews. Showing the latest {reviews.length}.</p>

      <div className="space-y-3">
        {reviews.length === 0 ? (
          <div className="text-center text-gray-400 py-10">No reviews yet.</div>
        ) : reviews.map(r => {
          const tech = r.matched_job_id ? techByJob.get(r.matched_job_id) : null
          return (
            <div key={r.id} className="bg-white border border-gray-200 rounded-lg px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Stars n={r.star_rating} />
                  <span className="text-sm font-medium text-gray-900">{r.reviewer_name || 'Anonymous'}</span>
                </div>
                <span className="text-xs text-gray-400">{fmtDate(r.created_at_google)}</span>
              </div>
              {r.comment && <p className="text-sm text-gray-700 mt-2 whitespace-pre-wrap">{r.comment}</p>}
              <div className="flex items-center gap-3 mt-2">
                {tech && <span className="text-xs text-gray-500">Tech: {tech}</span>}
                {r.reply_text && <span className="text-xs text-green-600">Replied</span>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
