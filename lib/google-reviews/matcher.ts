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
  closed_at: string | null
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

  // Load every non-deleted job that has a customer name. We deliberately do NOT
  // filter on closed_at — many jobs have a null closed_at and filtering on it
  // would exclude their customers from matching entirely. closed_at is used only
  // as an optional date-proximity bonus below.
  const jobs: ScoreJob[] = []
  let from = 0
  const PAGE = 1000
  for (;;) {
    const { data: page } = await supabase
      .from('sf_jobs')
      .select('id, customer_id, customer_name, contact_first_name, contact_last_name, closed_at')
      .eq('is_deleted', false)
      .not('customer_name', 'is', null)
      .order('id')
      .range(from, from + PAGE - 1)
    if (!page || page.length === 0) break
    for (const j of page as Array<{
      id: string; customer_id: string; customer_name: string | null
      contact_first_name: string | null; contact_last_name: string | null; closed_at: string | null
    }>) {
      jobs.push({
        id:             j.id,
        customer_id:    j.customer_id,
        customerTokens: j.customer_name ? tokenize(j.customer_name) : [],
        customerNorm:   j.customer_name ? normalize(j.customer_name) : '',
        first:          j.contact_first_name ? canonToken(normalize(j.contact_first_name)) : '',
        last:           j.contact_last_name ? normalize(j.contact_last_name) : '',
        closed_at:      j.closed_at,
      })
    }
    if (page.length < PAGE) break
    from += PAGE
  }

  if (jobs.length === 0) return { matched: 0, candidates: 0, noMatch: reviews.length }

  let matched = 0, candidates = 0, noMatch = 0

  for (const review of reviews as Array<{ id: string; reviewer_name: string; created_at_google: string }>) {
    const rNorm   = normalize(review.reviewer_name)
    const rTokens = tokenize(review.reviewer_name)

    let bestScore = 0
    let bestJob: ScoreJob | null = null

    for (const job of jobs) {
      const ns = scoreJob(rNorm, rTokens, job)
      if (ns === 0) continue
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
