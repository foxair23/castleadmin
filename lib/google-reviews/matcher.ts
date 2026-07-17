import { createClient } from '@supabase/supabase-js'

export interface MatchResult {
  matched: number
  candidates: number
  noMatch: number
  writeErrors?: number
  errors?: string[]
}

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z\s]/g, '').trim().replace(/\s+/g, ' ')
}

// Common nicknames / diminutives → canonical given name. Each variant maps to a
// single canonical token so "tim" and "timothy" (or "bob"/"robert") are treated
// as the same name during scoring. Bidirectional by design: the canonical form
// also maps to itself implicitly via canonToken's fallback.
const NICKNAMES: Record<string, string> = {
  abby: 'abigail',
  al: 'albert', bert: 'albert',
  alex: 'alexander', alexandra: 'alexander', sandy: 'alexander',
  andy: 'andrew', drew: 'andrew',
  tony: 'anthony',
  ben: 'benjamin', benji: 'benjamin', benny: 'benjamin',
  brad: 'bradley',
  cathy: 'catherine', kathy: 'catherine', cath: 'catherine', kate: 'catherine', katie: 'catherine', kat: 'catherine',
  chuck: 'charles', charlie: 'charles', chas: 'charles',
  chris: 'christopher', topher: 'christopher',
  dan: 'daniel', danny: 'daniel',
  dave: 'david', davey: 'david',
  deb: 'deborah', debbie: 'deborah', debra: 'deborah',
  don: 'donald', donnie: 'donald',
  doug: 'douglas',
  ed: 'edward', eddie: 'edward', eddy: 'edward', ned: 'edward', ted: 'edward', teddy: 'edward',
  liz: 'elizabeth', beth: 'elizabeth', betty: 'elizabeth', lizzie: 'elizabeth', eliza: 'elizabeth',
  frank: 'francis', frankie: 'francis',
  fred: 'frederick', freddy: 'frederick', freddie: 'frederick',
  gabe: 'gabriel',
  greg: 'gregory',
  hank: 'henry', harry: 'henry',
  jack: 'john', johnny: 'john', jon: 'john',
  jake: 'jacob',
  jim: 'james', jimmy: 'james', jamie: 'james',
  jeff: 'jeffrey',
  jen: 'jennifer', jenny: 'jennifer', jenn: 'jennifer',
  jess: 'jessica', jessie: 'jessica',
  joe: 'joseph', joey: 'joseph',
  ken: 'kenneth', kenny: 'kenneth',
  larry: 'lawrence', laurence: 'lawrence',
  len: 'leonard', lenny: 'leonard',
  matt: 'matthew',
  meg: 'margaret', maggie: 'margaret', peggy: 'margaret', marge: 'margaret',
  mike: 'michael', mick: 'michael', micky: 'michael',
  nate: 'nathaniel', nathan: 'nathaniel',
  nick: 'nicholas',
  pat: 'patrick', paddy: 'patrick',
  patty: 'patricia', tricia: 'patricia', trish: 'patricia',
  phil: 'philip', phillip: 'philip',
  ray: 'raymond',
  dick: 'richard', rich: 'richard', rick: 'richard', ricky: 'richard', richie: 'richard',
  bob: 'robert', bobby: 'robert', rob: 'robert', robbie: 'robert',
  ron: 'ronald', ronnie: 'ronald',
  sam: 'samuel', sammy: 'samuel',
  steve: 'stephen', steven: 'stephen', stevie: 'stephen',
  sue: 'susan', susie: 'susan', suzy: 'susan',
  tom: 'thomas', tommy: 'thomas',
  tim: 'timothy', timmy: 'timothy',
  vince: 'vincent',
  walt: 'walter', wally: 'walter',
  bill: 'william', billy: 'william', will: 'william', willy: 'william', willie: 'william', liam: 'william',
  zach: 'zachary', zack: 'zachary',
}

// Collapse a single token to its canonical given-name form when it's a known
// nickname; otherwise return it unchanged.
export function canonToken(t: string): string {
  return NICKNAMES[t] ?? t
}

export function tokenize(s: string): string[] {
  return normalize(s).split(' ').filter(t => t.length > 1).map(canonToken)
}

// Precomputed, normalized job record used by the scorer
export interface ScoreJob {
  id: string
  customer_id: string
  customerTokens: string[]
  customerNorm: string
  first: string
  last: string
  /** Best-known "when did this job happen" date — see effectiveJobDate(). */
  effective_date: string | null
}

// Raw job row from sf_jobs that we score against.
export interface RawJob {
  id: string
  customer_id: string
  customer_name: string | null
  contact_first_name: string | null
  contact_last_name: string | null
  closed_at: string | null
  start_date: string | null
}

/**
 * The date recency logic should use for a job. closed_at is only stamped when a
 * job reaches a closed status (Invoiced/Paid), so a just-completed job usually
 * still has closed_at = NULL when its review arrives — which made the recency
 * tie-break treat the customer's NEWEST job as "infinitely far away" and hand
 * the match to an old, dated job instead. SF also stores epoch-1970 closed_at
 * on some cancelled rows. Fall back to start_date in both cases. (ISO strings
 * compare correctly lexicographically.)
 */
export function effectiveJobDate(closedAt: string | null, startDate: string | null): string | null {
  if (closedAt && closedAt > '2000-01-01') return closedAt
  return startDate ?? null
}

// Build the precomputed ScoreJob from a raw sf_jobs row. The matchable token set
// is the UNION of customer_name tokens and contact first/last tokens, so a job is
// matchable whether the name lives in customer_name ("Frank, Edward"), in the
// contact fields, or both. customerNorm falls back to "first last" when
// customer_name is null.
export function buildScoreJob(j: RawJob): ScoreJob {
  const first = j.contact_first_name ? canonToken(normalize(j.contact_first_name)) : ''
  const last  = j.contact_last_name ? normalize(j.contact_last_name) : ''
  const tokenSet = new Set<string>()
  if (j.customer_name) for (const t of tokenize(j.customer_name)) tokenSet.add(t)
  if (first) tokenSet.add(first)
  if (last)  tokenSet.add(last)
  return {
    id:             j.id,
    customer_id:    j.customer_id,
    customerTokens: [...tokenSet],
    customerNorm:   j.customer_name ? normalize(j.customer_name) : [first, last].filter(Boolean).join(' '),
    first,
    last,
    effective_date: effectiveJobDate(j.closed_at, j.start_date),
  }
}

/**
 * Score a review's reviewer name against a single job.
 * Returns 0..1 (before any date bonus).
 */
export function scoreJob(rNorm: string, rTokens: string[], job: ScoreJob): number {
  if (rTokens.length === 0) return 0

  if (job.customerNorm && job.customerNorm === rNorm) return 1.0

  // Reviewer name fully contained in the customer name, order-independent.
  // Exact (same token count) → 1.0; subset (customer has extra tokens such as a
  // middle name, suffix, or spouse — "Frank, Edward & Mary") → 0.92 so it still
  // auto-matches. ("Edward Frank" matches customer "Frank, Edward".)
  if (rTokens.length >= 2 && rTokens.every(t => job.customerTokens.includes(t))) {
    return job.customerTokens.length === rTokens.length ? 1.0 : 0.92
  }

  // Exact contact first+last match (either order)
  if (job.first && job.last) {
    const full     = `${job.first} ${job.last}`
    const reversed = `${job.last} ${job.first}`
    if (rNorm === full || rNorm === reversed) return 1.0
  }

  let score = 0

  // Contact last/first name token matches
  if (job.last && rTokens.includes(job.last))  score += 0.60
  if (job.first && rTokens.includes(job.first)) score += 0.30

  // Customer-name token overlap (covers names not split into contact fields)
  const overlap = rTokens.filter(t => job.customerTokens.includes(t)).length
  if (overlap >= 2)      score = Math.max(score, 0.80)
  else if (overlap === 1) score = Math.max(score, 0.45)

  return Math.min(score, 0.99)
}

export function dateBonusDays(reviewDate: string, closedAt: string | null): number {
  if (!closedAt) return 0
  const diffDays = Math.abs(
    (new Date(reviewDate).getTime() - new Date(closedAt).getTime()) / 86400000
  )
  if (diffDays <= 7)  return 0.10
  if (diffDays <= 30) return 0.05
  if (diffDays <= 90) return 0.02
  return 0
}

export const AUTO_THRESHOLD      = 0.85
export const CANDIDATE_THRESHOLD = 0.45

export async function runMatchingPass(): Promise<MatchResult> {
  const supabase = db()

  const { data: reviews } = await supabase
    .from('google_reviews')
    .select('id, reviewer_name, created_at_google')
    .eq('match_status', 'pending_review')
    .is('deleted_at', null)
    .not('reviewer_name', 'is', null)

  if (!reviews || reviews.length === 0) return { matched: 0, candidates: 0, noMatch: 0 }

  // Load every non-deleted job that has a name we can match on. We use two
  // separate paginated queries — one for jobs that have a customer_name, one for
  // jobs whose name is stored only in the contact fields (null customer_name) —
  // because the supabase-js .or() syntax for IS NOT NULL is unreliable across
  // driver versions. Using .not('field','is',null) directly is guaranteed safe.
  const jobs: ScoreJob[] = []
  const JOB_SELECT = 'id, customer_id, customer_name, contact_first_name, contact_last_name, closed_at, start_date'

  // ── Pass 1: jobs with a customer_name ────────────────────────────────────
  let from = 0
  const PAGE = 1000
  for (;;) {
    const { data: page } = await supabase
      .from('sf_jobs')
      .select(JOB_SELECT)
      .eq('is_deleted', false)
      .not('customer_name', 'is', null)
      .order('id')
      .range(from, from + PAGE - 1)
    if (!page || page.length === 0) break
    for (const j of page as Array<{
      id: string; customer_id: string; customer_name: string | null
      contact_first_name: string | null; contact_last_name: string | null
      closed_at: string | null; start_date: string | null
    }>) {
      jobs.push(buildScoreJob(j))
    }
    if (page.length < PAGE) break
    from += PAGE
  }

  // ── Pass 2: jobs with null customer_name but a contact last name ──────────
  // These would have been silently excluded by the customer_name IS NOT NULL
  // filter and can now be matched via the contact fields.
  from = 0
  for (;;) {
    const { data: page } = await supabase
      .from('sf_jobs')
      .select(JOB_SELECT)
      .eq('is_deleted', false)
      .is('customer_name', null)
      .not('contact_last_name', 'is', null)
      .order('id')
      .range(from, from + PAGE - 1)
    if (!page || page.length === 0) break
    for (const j of page as Array<{
      id: string; customer_id: string; customer_name: string | null
      contact_first_name: string | null; contact_last_name: string | null
      closed_at: string | null; start_date: string | null
    }>) {
      jobs.push(buildScoreJob(j))
    }
    if (page.length < PAGE) break
    from += PAGE
  }

  if (jobs.length === 0) return { matched: 0, candidates: 0, noMatch: reviews.length }

  let matched = 0, candidates = 0, noMatch = 0, writeErrors = 0
  const errors: string[] = []

  for (const review of reviews as Array<{ id: string; reviewer_name: string; created_at_google: string }>) {
    const rNorm   = normalize(review.reviewer_name)
    const rTokens = tokenize(review.reviewer_name)

    let bestScore = 0
    let bestJob: ScoreJob | null = null
    let bestCloseness = Number.MAX_SAFE_INTEGER

    for (const job of jobs) {
      // A reviewer cannot review a job that hasn't happened yet. Skip jobs whose
      // effective date is more than 30 days after the review date — this
      // prevents future customer records from generating spurious candidates.
      if (job.effective_date) {
        const daysAfter = (new Date(job.effective_date).getTime() - new Date(review.created_at_google).getTime()) / 86400000
        if (daysAfter > 30) continue
      }

      const ns = scoreJob(rNorm, rTokens, job)
      if (ns === 0) continue
      const total = Math.min(ns + dateBonusDays(review.created_at_google, job.effective_date), 1.0)
      // Tie-break: a repeat customer's jobs all carry the same name score (and
      // an equal — often zero — date bonus once they're months old), and the
      // strict > kept whichever job happened to come FIRST, i.e. the oldest.
      // Reviews are about the most recent visit, so on equal score prefer the
      // job whose effective date is CLOSEST to the review date. (effective_date
      // falls back to start_date when closed_at isn't stamped yet — a freshly
      // completed, not-yet-invoiced job must not lose this tie-break.)
      const closeness = job.effective_date
        ? Math.abs(new Date(review.created_at_google).getTime() - new Date(job.effective_date).getTime())
        : Number.MAX_SAFE_INTEGER
      if (total > bestScore || (total === bestScore && closeness < bestCloseness)) {
        bestScore = total
        bestJob = job
        bestCloseness = closeness
      }
    }

    if (bestScore >= AUTO_THRESHOLD && bestJob) {
      const { error } = await supabase.from('google_reviews').update({
        match_status:        'auto',
        match_confidence:    'high',
        match_score:         bestScore,
        matched_customer_id: bestJob.customer_id,
        matched_job_id:      bestJob.id,
      }).eq('id', review.id)
      if (error) { writeErrors++; if (errors.length < 5) errors.push(`${review.reviewer_name}: ${error.message}`) }
      else matched++
    } else if (bestScore >= CANDIDATE_THRESHOLD && bestJob) {
      const { error } = await supabase.from('google_reviews').update({
        match_confidence:    'low',
        match_score:         bestScore,
        matched_customer_id: bestJob.customer_id,
        matched_job_id:      bestJob.id,
      }).eq('id', review.id)
      if (error) { writeErrors++; if (errors.length < 5) errors.push(`${review.reviewer_name}: ${error.message}`) }
      else candidates++
    } else {
      noMatch++
    }
  }

  return { matched, candidates, noMatch, writeErrors, errors }
}
