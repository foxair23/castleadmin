import { createClient } from '@supabase/supabase-js'

export interface MatchResult {
  matched: number
  candidates: number
  noMatch: number
}

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z\s]/g, '').trim().replace(/\s+/g, ' ')
}

function scoreNames(
  reviewerName: string,
  first: string | null,
  last: string | null,
  customerName: string | null,
): number {
  const r = normalize(reviewerName)
  if (!r) return 0

  const rTokens = r.split(' ').filter(t => t.length > 1)
  if (rTokens.length === 0) return 0

  // Match against customer name — try both "First Last" and "Last, First" orderings
  if (customerName) {
    const cn = normalize(customerName) // strips commas
    const cnTokens = cn.split(' ').filter(t => t.length > 1)
    // All tokens match regardless of order (catches "Frank Edward" == "Edward Frank")
    if (
      cnTokens.length >= 2 &&
      cnTokens.length === rTokens.length &&
      cnTokens.every(t => rTokens.includes(t))
    ) return 1.0
    if (cn === r) return 1.0
  }

  const f = first ? normalize(first) : ''
  const l = last ? normalize(last) : ''
  if (!f && !l) return 0

  // Exact first+last match (either order)
  const full     = [f, l].filter(Boolean).join(' ')
  const reversed = [l, f].filter(Boolean).join(' ')
  if (r === full || r === reversed) return 1.0

  let score = 0

  // Last name match (strongest signal)
  if (l && l.length > 1 && rTokens.includes(l)) score += 0.60

  // First name match
  if (f && f.length > 1 && rTokens.includes(f)) score += 0.30

  // Partial: first token of reviewer matches first name (handles "J. Smith" type names)
  if (f && f.length > 1 && rTokens[0] && f.startsWith(rTokens[0])) score = Math.max(score, 0.15)

  return Math.min(score, 0.99)
}

function dateBonusDays(reviewDate: string, closedAt: string | null): number {
  if (!closedAt) return 0
  const diffDays = Math.abs(
    (new Date(reviewDate).getTime() - new Date(closedAt).getTime()) / 86400000
  )
  if (diffDays <= 7)  return 0.10
  if (diffDays <= 30) return 0.05
  if (diffDays <= 90) return 0.02
  return 0
}

const AUTO_THRESHOLD      = 0.85
const CANDIDATE_THRESHOLD = 0.45

export async function runMatchingPass(): Promise<MatchResult> {
  const supabase = db()

  const { data: reviews } = await supabase
    .from('google_reviews')
    .select('id, reviewer_name, created_at_google')
    .eq('match_status', 'pending_review')
    .is('deleted_at', null)
    .not('reviewer_name', 'is', null)

  if (!reviews || reviews.length === 0) return { matched: 0, candidates: 0, noMatch: 0 }

  const twoYearsAgo = new Date(Date.now() - 5 * 365 * 24 * 60 * 60 * 1000).toISOString()

  // Paginate sf_jobs to avoid 1000-row cap
  const jobs: Array<{
    id: string
    customer_id: string
    customer_name: string | null
    contact_first_name: string | null
    contact_last_name: string | null
    closed_at: string | null
  }> = []

  let from = 0
  const PAGE = 1000
  for (;;) {
    const { data: page } = await supabase
      .from('sf_jobs')
      .select('id, customer_id, customer_name, contact_first_name, contact_last_name, closed_at')
      .eq('is_deleted', false)
      .not('customer_name', 'is', null)
      .gte('closed_at', twoYearsAgo)
      .order('id')
      .range(from, from + PAGE - 1)
    if (!page || page.length === 0) break
    jobs.push(...page)
    if (page.length < PAGE) break
    from += PAGE
  }

  if (jobs.length === 0) return { matched: 0, candidates: 0, noMatch: reviews.length }

  let matched = 0, candidates = 0, noMatch = 0

  for (const review of reviews as Array<{ id: string; reviewer_name: string; created_at_google: string }>) {
    let bestScore = 0
    let bestJob: typeof jobs[0] | null = null

    for (const job of jobs) {
      const ns = scoreNames(review.reviewer_name, job.contact_first_name, job.contact_last_name, job.customer_name)
      const total = Math.min(ns + dateBonusDays(review.created_at_google, job.closed_at), 1.0)
      if (total > bestScore) {
        bestScore = total
        bestJob = job
      }
    }

    if (bestScore >= AUTO_THRESHOLD && bestJob) {
      await supabase.from('google_reviews').update({
        match_status:        'auto',
        match_confidence:    'high',
        match_score:         bestScore,
        matched_customer_id: bestJob.customer_id,
        matched_job_id:      bestJob.id,
      }).eq('id', review.id)
      matched++
    } else if (bestScore >= CANDIDATE_THRESHOLD && bestJob) {
      await supabase.from('google_reviews').update({
        match_confidence:    'low',
        match_score:         bestScore,
        matched_customer_id: bestJob.customer_id,
        matched_job_id:      bestJob.id,
      }).eq('id', review.id)
      candidates++
    } else {
      noMatch++
    }
  }

  return { matched, candidates, noMatch }
}
