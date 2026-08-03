import { csatDb } from './config'
import { summarizeRatings, type RatingSummary } from './summary'

export { summarizeRatings, type RatingSummary } from './summary'

// CSAT metrics. The pure roll-up lives in ./summary; `getCsatMetrics` fetches
// current responses joined to their surveys and rolls them up, with optional
// filters and grouping for the dashboard/reports.

export interface CsatFilters {
  from?: string | null          // ISO date (inclusive), compared against sent_at
  to?: string | null            // ISO date (inclusive)
  techUserId?: string | null
  jobCategory?: string | null
  jobSource?: string | null
  city?: string | null
  postalCode?: string | null
}

export interface CsatDashboard extends RatingSummary {
  surveysSent: number
  /** valid responses ÷ surveys sent × 100 (we can't track carrier "delivered"). */
  responseRate: number | null
  openFollowUps: number
  byTech: Array<{ key: string; label: string } & RatingSummary>
  byJobCategory: Array<{ key: string; label: string } & RatingSummary>
  byJobSource: Array<{ key: string; label: string } & RatingSummary>
  byCity: Array<{ key: string; label: string } & RatingSummary>
}

interface SurveyRow {
  id: string
  sf_job_id: string
  primary_tech_user_id: string | null
  primary_tech_name: string | null
  assigned_tech_ids: string[] | null
  job_category: string | null
  job_source: string | null
  city: string | null
  postal_code: string | null
  status: string
  sent_at: string | null
  is_test: boolean
}
interface ResponseRow { survey_id: string; rating: number | null }

/**
 * Compute the CSAT dashboard. Response rate uses surveys **sent** as the
 * denominator (Dialpad exposes no carrier delivery receipt in this codebase),
 * so it is "response rate of sent" — labeled as such in the UI.
 */
export async function getCsatMetrics(
  filters: CsatFilters = {},
  techNames: Map<string, string> = new Map(),
): Promise<CsatDashboard> {
  const db = csatDb()

  // Sent, non-test surveys within the window + filters.
  let sq = db
    .from('csat_surveys')
    .select('id, sf_job_id, primary_tech_user_id, primary_tech_name, assigned_tech_ids, job_category, job_source, city, postal_code, status, sent_at, is_test')
    .not('sent_at', 'is', null)
    .eq('is_test', false)
  if (filters.from) sq = sq.gte('sent_at', filters.from)
  if (filters.to) sq = sq.lte('sent_at', filters.to)
  if (filters.techUserId) sq = sq.eq('primary_tech_user_id', filters.techUserId)
  if (filters.jobCategory) sq = sq.eq('job_category', filters.jobCategory)
  if (filters.jobSource) sq = sq.eq('job_source', filters.jobSource)
  if (filters.city) sq = sq.eq('city', filters.city)
  if (filters.postalCode) sq = sq.eq('postal_code', filters.postalCode)

  const { data: surveyData } = await sq.limit(10000)
  const surveys = (surveyData ?? []) as SurveyRow[]
  const surveyIds = surveys.map(s => s.id)

  // Current valid rating per survey.
  const ratingBySurvey = new Map<string, number>()
  if (surveyIds.length) {
    const { data: respData } = await db
      .from('csat_responses')
      .select('survey_id, rating')
      .eq('is_current', true)
      .in('survey_id', surveyIds)
    for (const r of (respData ?? []) as ResponseRow[]) {
      if (r.rating != null) ratingBySurvey.set(r.survey_id, r.rating)
    }
  }

  const allRatings = [...ratingBySurvey.values()]
  const overall = summarizeRatings(allRatings)

  // Group helper: bucket surveys by a {key,label} descriptor, summarize each.
  const groupBy = (descriptorOf: (s: SurveyRow) => { key: string; label: string } | null) => {
    const buckets = new Map<string, { label: string; ratings: number[] }>()
    for (const s of surveys) {
      const rating = ratingBySurvey.get(s.id)
      if (rating == null) continue
      const d = descriptorOf(s)
      if (!d) continue
      const b = buckets.get(d.key) ?? { label: d.label, ratings: [] }
      b.ratings.push(rating)
      buckets.set(d.key, b)
    }
    return [...buckets.entries()]
      .map(([key, b]) => ({ key, label: b.label, ...summarizeRatings(b.ratings) }))
      .sort((a, b) => b.responses - a.responses)
  }

  // Per tech: key on the app-user id when mapped (links to the tech's own view),
  // else on the snapshotted name so unmapped techs still get a score.
  const techDescriptor = (s: SurveyRow) => {
    if (s.primary_tech_user_id) return { key: s.primary_tech_user_id, label: techNames.get(s.primary_tech_user_id) ?? s.primary_tech_name ?? 'Unknown' }
    if (s.primary_tech_name) return { key: `name:${s.primary_tech_name}`, label: s.primary_tech_name }
    return { key: 'unassigned', label: 'Unassigned' }
  }

  const openFollowUps = surveyIds.length
    ? (await db.from('csat_follow_ups').select('id', { count: 'exact', head: true }).eq('status', 'open')).count ?? 0
    : 0

  return {
    ...overall,
    surveysSent: surveys.length,
    responseRate: surveys.length ? Math.round((overall.responses / surveys.length) * 100) : null,
    openFollowUps,
    byTech: groupBy(techDescriptor),
    byJobCategory: groupBy(s => s.job_category ? { key: s.job_category, label: s.job_category } : null),
    byJobSource: groupBy(s => s.job_source ? { key: s.job_source, label: s.job_source } : null),
    byCity: groupBy(s => s.city ? { key: s.city, label: s.city } : null),
  }
}

/** A single technician's own CSAT summary (for their read-only self-view).
 *  Matches on the app-user link or the snapshotted name so unmapped techs still
 *  see their scores. Uses the service client (CSAT tables are admin-RLS). */
export async function getTechCsatSummary(techUserId: string, fullName: string | null): Promise<RatingSummary> {
  const db = csatDb()
  const base = () => db.from('csat_surveys').select('id').eq('is_test', false).not('sent_at', 'is', null)
  // Two clean queries (avoids .or() string interpolation, which a name with a
  // comma/dot would break), then union the survey ids.
  const [{ data: byId }, byName] = await Promise.all([
    base().eq('primary_tech_user_id', techUserId).limit(5000),
    fullName ? base().eq('primary_tech_name', fullName).limit(5000) : Promise.resolve({ data: [] as Array<{ id: string }> }),
  ])
  const ids = [...new Set([...(byId ?? []), ...((byName.data ?? []) as Array<{ id: string }>)].map(s => (s as { id: string }).id))]
  if (ids.length === 0) return summarizeRatings([])
  const { data: resp } = await db
    .from('csat_responses').select('rating').eq('is_current', true).in('survey_id', ids)
  const ratings = (resp ?? []).map(r => (r as { rating: number | null }).rating).filter((n): n is number => n != null)
  return summarizeRatings(ratings)
}

// ── Flat rows for the admin table (client computes metrics/filters/CSV) ───────

export interface CsatRow {
  survey_id: string
  sf_job_id: string
  customer_name: string | null
  phone_e164: string | null
  status: string
  sent_at: string | null
  work_completed_at: string | null
  primary_tech_user_id: string | null
  primary_tech_name: string | null
  job_category: string | null
  job_source: string | null
  city: string | null
  postal_code: string | null
  rating: number | null
  feedback_text: string | null
  responded_at: string | null
  review_requested_at: string | null
  follow_up_status: string | null
}

/** Every non-test survey (most recent first) with its current rating + follow-up. */
export async function getCsatRows(limit = 2000): Promise<CsatRow[]> {
  const db = csatDb()
  const { data: surveyData } = await db
    .from('csat_surveys')
    .select('id, sf_job_id, customer_name, phone_e164, status, sent_at, work_completed_at, primary_tech_user_id, primary_tech_name, job_category, job_source, city, postal_code, review_requested_at')
    .eq('is_test', false)
    .order('sent_at', { ascending: false, nullsFirst: false })
    .limit(limit)
  const surveys = (surveyData ?? []) as Array<Record<string, unknown>>
  const ids = surveys.map(s => s.id as string)

  const curr = new Map<string, { rating: number | null; feedback_text: string | null; received_at: string }>()
  const followUp = new Map<string, string>()
  if (ids.length) {
    const [{ data: resp }, { data: fu }] = await Promise.all([
      db.from('csat_responses').select('survey_id, rating, feedback_text, received_at').eq('is_current', true).in('survey_id', ids),
      db.from('csat_follow_ups').select('survey_id, status').in('survey_id', ids),
    ])
    for (const r of (resp ?? []) as Array<{ survey_id: string; rating: number | null; feedback_text: string | null; received_at: string }>) {
      curr.set(r.survey_id, { rating: r.rating, feedback_text: r.feedback_text, received_at: r.received_at })
    }
    for (const f of (fu ?? []) as Array<{ survey_id: string; status: string }>) followUp.set(f.survey_id, f.status)
  }

  return surveys.map(s => {
    const c = curr.get(s.id as string)
    return {
      survey_id: s.id as string,
      sf_job_id: s.sf_job_id as string,
      customer_name: (s.customer_name as string) ?? null,
      phone_e164: (s.phone_e164 as string) ?? null,
      status: s.status as string,
      sent_at: (s.sent_at as string) ?? null,
      work_completed_at: (s.work_completed_at as string) ?? null,
      primary_tech_user_id: (s.primary_tech_user_id as string) ?? null,
      primary_tech_name: (s.primary_tech_name as string) ?? null,
      job_category: (s.job_category as string) ?? null,
      job_source: (s.job_source as string) ?? null,
      city: (s.city as string) ?? null,
      postal_code: (s.postal_code as string) ?? null,
      rating: c?.rating ?? null,
      feedback_text: c?.feedback_text ?? null,
      responded_at: c?.received_at ?? null,
      review_requested_at: (s.review_requested_at as string) ?? null,
      follow_up_status: followUp.get(s.id as string) ?? null,
    }
  })
}
