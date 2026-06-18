import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  normalize, tokenize, scoreJob, dateBonusDays, buildScoreJob,
  AUTO_THRESHOLD, CANDIDATE_THRESHOLD,
} from '@/lib/google-reviews/matcher'

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
  const { data: profile } = await db.from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') return null
  return user
}

// GET /api/admin/reviews/diagnose?q=edward frank
// Shows exactly what the matcher sees for a given reviewer, and why it scores
// the way it does. Admin-only debugging aid.
export async function GET(req: NextRequest) {
  if (!await requireAdmin()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const q = new URL(req.url).searchParams.get('q')?.trim() ?? ''
  const jobIdParam = new URL(req.url).searchParams.get('job')?.trim() ?? ''
  if (!q && !jobIdParam) return NextResponse.json({ error: 'pass ?q=<reviewer name> and/or ?job=<job id>' }, { status: 400 })

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  // 0. Direct job lookup — inspect a specific job id verbatim (no name filter, and
  // is_deleted is shown rather than hidden). Use this to check whether a job the
  // user expects (e.g. "Frank, Edward / 1020258343") actually exists in sf_jobs and
  // what its name fields really contain.
  let lookupJob: unknown = null
  if (jobIdParam) {
    const { data: jrow, error: jerr } = await db
      .from('sf_jobs')
      .select('id, customer_id, customer_name, contact_first_name, contact_last_name, closed_at, is_deleted')
      .eq('id', jobIdParam)
      .maybeSingle()
    lookupJob = jerr ? { error: jerr.message } : (jrow ?? { found: false, note: `No sf_jobs row with id=${jobIdParam}` })
  }

  // 1. The review(s) matching this name
  const { data: reviews } = q ? await db
    .from('google_reviews')
    .select('id, reviewer_name, created_at_google, match_status, match_confidence, match_score, matched_customer_id, matched_job_id, deleted_at')
    .ilike('reviewer_name', `%${q}%`)
    .limit(5) : { data: [] }

  const rNorm   = normalize(q)
  const rTokens = tokenize(q)

  // 2. Candidate jobs — any job whose customer_name OR contact name fields contain
  // one of the reviewer's name tokens. Use RAW (pre-canonicalized) tokens for the
  // ILIKE so we match the literal text stored in the DB. Also search contact fields
  // so jobs with null customer_name still surface. High limit so we don't truncate
  // away the real match when a common token (e.g. "frank") hits hundreds of jobs.
  const rawTokens  = normalize(q).split(' ').filter(t => t.length > 1)
  const jobFilters = rawTokens.flatMap(t => [
    `customer_name.ilike.%${t}%`,
    `contact_first_name.ilike.%${t}%`,
    `contact_last_name.ilike.%${t}%`,
  ]).join(',')
  const { data: rawJobs } = q ? await db
    .from('sf_jobs')
    .select('id, customer_id, customer_name, contact_first_name, contact_last_name, closed_at, is_deleted')
    .or(jobFilters)
    .limit(2000) : { data: [] }

  // 2b. Tight search — jobs whose customer_name contains ALL of the reviewer's raw
  // tokens (e.g. "edward" AND "frank"). Chained .ilike() calls AND together, so this
  // narrow query directly surfaces "Frank, Edward" regardless of how many "frank"-only
  // jobs exist. This is the truncation-proof way to prove a job is/ isn't present.
  let tightQ = db
    .from('sf_jobs')
    .select('id, customer_id, customer_name, contact_first_name, contact_last_name, closed_at, is_deleted')
  for (const t of rawTokens) tightQ = tightQ.ilike('customer_name', `%${t}%`)
  const { data: tightRows } = q && rawTokens.length > 0 ? await tightQ.limit(50) : { data: [] }
  const tightMatches = (tightRows ?? []).map((j: {
    id: string; customer_id: string; customer_name: string | null
    contact_first_name: string | null; contact_last_name: string | null
    closed_at: string | null; is_deleted: boolean
  }) => {
    const sj = buildScoreJob(j)
    const base = scoreJob(rNorm, rTokens, sj)
    return {
      job_id: j.id, customer_id: j.customer_id, job_customer_name: j.customer_name,
      contact: [j.contact_first_name, j.contact_last_name].filter(Boolean).join(' ') || null,
      match_tokens: sj.customerTokens, is_deleted: j.is_deleted,
      base_score: Math.round(base * 100) / 100,
      verdict: base >= AUTO_THRESHOLD ? 'AUTO' : base >= CANDIDATE_THRESHOLD ? 'candidate' : 'no-match',
    }
  })

  const reviewDate = (reviews?.[0]?.created_at_google as string | undefined) ?? new Date().toISOString()

  const scored = (rawJobs ?? []).map((j: {
    id: string; customer_id: string; customer_name: string | null
    contact_first_name: string | null; contact_last_name: string | null
    closed_at: string | null; is_deleted: boolean
  }) => {
    const sj    = buildScoreJob(j)
    const base  = scoreJob(rNorm, rTokens, sj)
    const bonus = dateBonusDays(reviewDate, j.closed_at)
    const total = Math.min(base + bonus, 1.0)
    return {
      job_id:         j.id,
      customer_id:    j.customer_id,
      job_customer_name: j.customer_name,
      contact:        [j.contact_first_name, j.contact_last_name].filter(Boolean).join(' ') || null,
      match_tokens:   sj.customerTokens,
      closed_at:      j.closed_at,
      is_deleted:     j.is_deleted,
      excluded_from_matching: j.is_deleted,
      base_score:     Math.round(base * 100) / 100,
      date_bonus:     bonus,
      total_score:    Math.round(total * 100) / 100,
      verdict:        total >= AUTO_THRESHOLD ? 'AUTO' : total >= CANDIDATE_THRESHOLD ? 'candidate' : 'no-match',
    }
  }).sort((a, b) => b.total_score - a.total_score)

  // 3. Optional rematch — if ?rematch=true and there's exactly one review and the
  // tight_matches contain an AUTO-verdict job, write the match directly to the DB.
  // This bypasses the batch matcher and is the fastest way to unstick a review
  // whose scoring is provably correct but the batch run isn't reaching it.
  const rematch = new URL(req.url).searchParams.get('rematch') === 'true'
  let rematchResult: unknown = null
  if (rematch && reviews && reviews.length === 1) {
    const review = reviews[0] as { id: string; created_at_google: string }
    const bestTight = tightMatches
      .filter(j => !j.is_deleted)
      .map(j => {
        const bonus = dateBonusDays(review.created_at_google, (rawJobs ?? []).find((r: { id: string }) => r.id === j.job_id)?.closed_at ?? null)
        return { ...j, total_score: Math.min(j.base_score + bonus, 1.0) }
      })
      .sort((a, b) => b.total_score - a.total_score)[0]

    if (bestTight && bestTight.total_score >= AUTO_THRESHOLD) {
      const { error: updateErr } = await db.from('google_reviews').update({
        match_status:        'auto',
        match_confidence:    'high',
        match_score:         bestTight.total_score,
        matched_customer_id: bestTight.customer_id,
        matched_job_id:      bestTight.job_id,
      }).eq('id', review.id)
      rematchResult = updateErr
        ? { ok: false, error: updateErr.message }
        : { ok: true, matched_to: bestTight.job_customer_name, job_id: bestTight.job_id, score: bestTight.total_score }
    } else {
      rematchResult = { ok: false, reason: 'No AUTO-threshold tight match found', best: bestTight ?? null }
    }
  }

  return NextResponse.json({
    query: q,
    reviewer_tokens: rTokens,
    reviews,
    thresholds: { auto: AUTO_THRESHOLD, candidate: CANDIDATE_THRESHOLD },
    lookup_job: lookupJob,
    tight_matches: tightMatches,
    rematch: rematchResult,
    candidate_count: scored.length,
    candidate_jobs: scored,
  })
}
