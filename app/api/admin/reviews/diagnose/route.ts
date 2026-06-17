import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  normalize, tokenize, canonToken, scoreJob, dateBonusDays,
  AUTO_THRESHOLD, CANDIDATE_THRESHOLD, type ScoreJob,
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
  if (!q) return NextResponse.json({ error: 'pass ?q=<reviewer name>' }, { status: 400 })

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  // 1. The review(s) matching this name
  const { data: reviews } = await db
    .from('google_reviews')
    .select('id, reviewer_name, created_at_google, match_status, match_confidence, match_score, matched_customer_id, matched_job_id, deleted_at')
    .ilike('reviewer_name', `%${q}%`)
    .limit(5)

  const rNorm   = normalize(q)
  const rTokens = tokenize(q)

  // 2. Candidate jobs — any job whose customer_name contains one of the tokens.
  // Use RAW (pre-canonicalized) tokens for the ILIKE so we match the literal text
  // stored in the DB. tokenize() folds nicknames ("frank"→"francis"), which would
  // never appear verbatim in customer_name.
  const rawTokens  = normalize(q).split(' ').filter(t => t.length > 1)
  const jobFilters = rawTokens.map(t => `customer_name.ilike.%${t}%`).join(',')
  const { data: rawJobs } = await db
    .from('sf_jobs')
    .select('id, customer_id, customer_name, contact_first_name, contact_last_name, closed_at, is_deleted')
    .or(jobFilters)
    .limit(100)

  const reviewDate = (reviews?.[0]?.created_at_google as string | undefined) ?? new Date().toISOString()

  const scored = (rawJobs ?? []).map((j: {
    id: string; customer_id: string; customer_name: string | null
    contact_first_name: string | null; contact_last_name: string | null
    closed_at: string | null; is_deleted: boolean
  }) => {
    const sj: ScoreJob = {
      id:             j.id,
      customer_id:    j.customer_id,
      customerTokens: j.customer_name ? tokenize(j.customer_name) : [],
      customerNorm:   j.customer_name ? normalize(j.customer_name) : '',
      first:          j.contact_first_name ? canonToken(normalize(j.contact_first_name)) : '',
      last:           j.contact_last_name ? normalize(j.contact_last_name) : '',
      closed_at:      j.closed_at,
    }
    const base  = scoreJob(rNorm, rTokens, sj)
    const bonus = dateBonusDays(reviewDate, j.closed_at)
    const total = Math.min(base + bonus, 1.0)
    return {
      job_id:         j.id,
      customer_id:    j.customer_id,
      job_customer_name: j.customer_name,
      contact:        [j.contact_first_name, j.contact_last_name].filter(Boolean).join(' ') || null,
      closed_at:      j.closed_at,
      is_deleted:     j.is_deleted,
      excluded_from_matching: j.is_deleted || !j.customer_name,
      base_score:     Math.round(base * 100) / 100,
      date_bonus:     bonus,
      total_score:    Math.round(total * 100) / 100,
      verdict:        total >= AUTO_THRESHOLD ? 'AUTO' : total >= CANDIDATE_THRESHOLD ? 'candidate' : 'no-match',
    }
  }).sort((a, b) => b.total_score - a.total_score)

  return NextResponse.json({
    query: q,
    reviewer_tokens: rTokens,
    reviews,
    thresholds: { auto: AUTO_THRESHOLD, candidate: CANDIDATE_THRESHOLD },
    candidate_jobs: scored,
  })
}
