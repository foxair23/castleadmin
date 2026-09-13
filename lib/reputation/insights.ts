import type { SupabaseClient } from '@supabase/supabase-js'
import { THEMES } from './tagging'
import { PHOTO_SELECT, isUsable, type JobPhotoRow } from './photos'
export { THEME_LABEL } from './theme-labels'

// Insights (PRD §5): the review funnel, what customers talk about, which techs
// they name, how fast we answer, and how good the job photos are. Everything is
// computed from rows already in the database — no Google calls. The pure
// summarize* functions are unit-tested; loadInsights just fetches and calls them.

export interface DateWindow { fromIso: string; toIso: string }

// ── Funnel ──────────────────────────────────────────────────────────────────

export interface FunnelSurveyRow {
  sent_at: string | null; status: string; rating: number | null; review_requested_at: string | null
  review_link_clicked_at: string | null; survey_reminder_sent_at: string | null; review_reminder_sent_at: string | null
  primary_tech_name: string | null; sf_job_id: string
}
export interface FunnelCounts { sent: number; responded: number; fives: number; linkSent: number; clicked: number; reviewed: number; surveyReminders: number; reviewReminders: number }
export interface Funnel { total: FunnelCounts; byTech: Array<{ tech: string } & FunnelCounts> }

const emptyFunnel = (): FunnelCounts => ({ sent: 0, responded: 0, fives: 0, linkSent: 0, clicked: 0, reviewed: 0, surveyReminders: 0, reviewReminders: 0 })

/** Pure: surveys sent in the window, stepped down to posted reviews. reviewedJobIds = jobs with a matched Google review. */
export function summarizeFunnel(rows: FunnelSurveyRow[], reviewedJobIds: Set<string>): Funnel {
  const total = emptyFunnel()
  const byTech = new Map<string, FunnelCounts>()
  for (const r of rows) {
    if (!r.sent_at) continue
    const tech = r.primary_tech_name?.trim() || 'Unassigned'
    const t = byTech.get(tech) ?? emptyFunnel()
    for (const c of [total, t]) {
      c.sent++
      if (r.rating != null || r.status === 'responded') c.responded++
      if (r.rating === 5) c.fives++
      if (r.review_requested_at) c.linkSent++
      if (r.review_link_clicked_at) c.clicked++
      if (reviewedJobIds.has(r.sf_job_id)) c.reviewed++
      if (r.survey_reminder_sent_at) c.surveyReminders++
      if (r.review_reminder_sent_at) c.reviewReminders++
    }
    byTech.set(tech, t)
  }
  return { total, byTech: [...byTech].map(([tech, c]) => ({ tech, ...c })).sort((a, b) => b.sent - a.sent || a.tech.localeCompare(b.tech)) }
}

// ── Themes and mentions ─────────────────────────────────────────────────────

export interface TaggedReviewRow {
  id: string; star_rating: number; comment: string | null; created_at_google: string; ai_sentiment: string | null
  ai_themes: string[] | null; ai_mentioned_names: string[] | null; matched_job_id: string | null; reviewer_name: string | null
}
export interface ThemeRow { theme: string; positive: number; negative: number; quotes: Array<{ stars: number; text: string }> }

/** Pure: how often each theme shows up in 4–5 star vs 1–3 star reviews, with a couple of short quotes each. */
export function summarizeThemes(reviews: TaggedReviewRow[]): { themes: ThemeRow[]; tagged: number; untagged: number } {
  const map = new Map<string, ThemeRow>()
  for (const t of THEMES) map.set(t, { theme: t, positive: 0, negative: 0, quotes: [] })
  let tagged = 0, untagged = 0
  for (const r of reviews) {
    const themes = r.ai_themes ?? []
    if (!r.ai_sentiment && themes.length === 0) { untagged++; continue }
    tagged++
    for (const t of themes) {
      const row = map.get(t) ?? { theme: t, positive: 0, negative: 0, quotes: [] }
      if (r.star_rating >= 4) row.positive++; else row.negative++
      const text = (r.comment ?? '').trim()
      // Keep one quote per band, shortest usable first so the card stays readable.
      if (text && row.quotes.length < 2 && !row.quotes.some(q => (q.stars >= 4) === (r.star_rating >= 4))) row.quotes.push({ stars: r.star_rating, text: text.length > 180 ? `${text.slice(0, 177)}…` : text })
      map.set(t, row)
    }
  }
  const themes = [...map.values()].sort((a, b) => (b.positive + b.negative) - (a.positive + a.negative) || a.theme.localeCompare(b.theme))
  return { themes, tagged, untagged }
}

export interface MentionRow { name: string; mentions: number; fives: number; matchesCreditedTech: number; mismatches: number }

/** Pure: names customers wrote on their own, grouped by first name (customers rarely write surnames), and whether the job's tech list agrees. techsByJob: job id → tech full names. */
export function summarizeMentions(reviews: TaggedReviewRow[], techsByJob: Map<string, string[]>): MentionRow[] {
  const map = new Map<string, MentionRow>()
  for (const r of reviews) {
    for (const raw of r.ai_mentioned_names ?? []) {
      const name = raw.trim().replace(/\s+/g, ' ')
      if (!name) continue
      const key = name.toLowerCase().split(' ')[0]
      const row = map.get(key) ?? { name, mentions: 0, fives: 0, matchesCreditedTech: 0, mismatches: 0 }
      if (name.length > row.name.length) row.name = name
      row.mentions++
      if (r.star_rating === 5) row.fives++
      const techs = r.matched_job_id ? techsByJob.get(r.matched_job_id) ?? [] : []
      if (techs.length) {
        if (techs.some(t => t.toLowerCase().split(/\s+/)[0] === key)) row.matchesCreditedTech++; else row.mismatches++
      }
      map.set(key, row)
    }
  }
  return [...map.values()].sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name))
}

// ── Reply performance ───────────────────────────────────────────────────────

export interface ReplyPerfReviewRow { id: string; created_at_google: string; reply_text: string | null; reply_updated_at: string | null; reply_source: string | null; deleted_at: string | null }
export interface ReplyPerfReplyRow { google_review_id: string; status: string; sent_at: string | null; approved_by: string | null; approved_at: string | null; draft_text: string; final_text: string | null }
export interface ReplyPerf {
  reviewsInWindow: number; replied: number; unreplied: number; waitingApproval: number; scheduled: number
  medianHours: number | null; within24h: number; within48h: number; timed: number
  byAgent: number; byHand: number; preExisting: number; autopilot: number; editedBeforeApproval: number
}

/** Pure: reply coverage and speed for reviews created in the window. */
export function summarizeReplies(reviews: ReplyPerfReviewRow[], replies: ReplyPerfReplyRow[]): ReplyPerf {
  const byReview = new Map<string, ReplyPerfReplyRow[]>()
  for (const r of replies) byReview.set(r.google_review_id, [...(byReview.get(r.google_review_id) ?? []), r])
  const out: ReplyPerf = { reviewsInWindow: 0, replied: 0, unreplied: 0, waitingApproval: 0, scheduled: 0, medianHours: null, within24h: 0, within48h: 0, timed: 0, byAgent: 0, byHand: 0, preExisting: 0, autopilot: 0, editedBeforeApproval: 0 }
  const hours: number[] = []
  for (const r of reviews) {
    if (r.deleted_at) continue
    out.reviewsInWindow++
    const mine = byReview.get(r.id) ?? []
    if (r.reply_text) {
      out.replied++
      if (r.reply_source === 'agent') out.byAgent++; else if (r.reply_source === 'pre_existing') out.preExisting++; else out.byHand++
      const sent = mine.find(x => x.status === 'posted' || x.status === 'verified')
      if (sent) {
        if (!sent.approved_by && sent.approved_at) out.autopilot++
        if (sent.final_text && sent.final_text.trim() !== sent.draft_text.trim()) out.editedBeforeApproval++
      }
      const when = sent?.sent_at ?? r.reply_updated_at
      if (when) {
        const h = (new Date(when).getTime() - new Date(r.created_at_google).getTime()) / 3_600_000
        if (h >= 0) { hours.push(h); out.timed++; if (h <= 24) out.within24h++; if (h <= 48) out.within48h++ }
      }
    } else {
      out.unreplied++
      if (mine.some(x => x.status === 'draft')) out.waitingApproval++
      if (mine.some(x => x.status === 'approved' || x.status === 'scheduled')) out.scheduled++
    }
  }
  if (hours.length) { hours.sort((a, b) => a - b); const m = Math.floor(hours.length / 2); out.medianHours = hours.length % 2 ? hours[m] : (hours[m - 1] + hours[m]) / 2 }
  return out
}

// ── Photo quality by tech ───────────────────────────────────────────────────

export interface PhotoTechRow { tech: string; jobs: number; photos: number; scored: number; avgScore: number | null; usable: number; usableShare: number | null; topReasons: Array<{ reason: string; count: number }> }

/** Pure: per tech, how many photos, how good, and the most common reasons a photo fell short. */
export function summarizePhotos(photos: Array<Pick<JobPhotoRow, 'sf_job_id' | 'score' | 'score_reasons' | 'public_url' | 'override_usable'>>, techsByJob: Map<string, string[]>, threshold: number): { byTech: PhotoTechRow[]; total: { photos: number; scored: number; avgScore: number | null; usable: number } } {
  const map = new Map<string, { jobs: Set<string>; photos: number; scored: number; sum: number; usable: number; reasons: Map<string, number> }>()
  const total = { photos: 0, scored: 0, sum: 0, usable: 0 }
  for (const p of photos) {
    const techs = techsByJob.get(p.sf_job_id) ?? ['Unassigned']
    const usable = isUsable(p as JobPhotoRow, threshold)
    total.photos++; if (p.score != null) { total.scored++; total.sum += p.score } if (usable) total.usable++
    for (const tech of techs) {
      const t = map.get(tech) ?? { jobs: new Set<string>(), photos: 0, scored: 0, sum: 0, usable: 0, reasons: new Map<string, number>() }
      t.jobs.add(p.sf_job_id); t.photos++
      if (p.score != null) { t.scored++; t.sum += p.score }
      if (usable) t.usable++
      else if (p.score != null) for (const reason of (p.score_reasons ?? []).slice(0, 2)) t.reasons.set(reason, (t.reasons.get(reason) ?? 0) + 1)
      map.set(tech, t)
    }
  }
  const byTech: PhotoTechRow[] = [...map].map(([tech, t]) => ({
    tech, jobs: t.jobs.size, photos: t.photos, scored: t.scored, avgScore: t.scored ? Math.round(t.sum / t.scored) : null,
    usable: t.usable, usableShare: t.photos ? Math.round(t.usable / t.photos * 100) : null,
    topReasons: [...t.reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 3),
  })).sort((a, b) => (b.avgScore ?? -1) - (a.avgScore ?? -1) || b.photos - a.photos)
  return { byTech, total: { photos: total.photos, scored: total.scored, avgScore: total.scored ? Math.round(total.sum / total.scored) : null, usable: total.usable } }
}

// ── Everything for the tab and the digest ───────────────────────────────────

export interface Insights {
  window: DateWindow
  reviews: { count: number; avg: number | null; fives: number; ones: number; removed: number; byStar: Record<1 | 2 | 3 | 4 | 5, number> }
  funnel: Funnel
  themes: ReturnType<typeof summarizeThemes>
  mentions: MentionRow[]
  replies: ReplyPerf
  photos: ReturnType<typeof summarizePhotos>
  posts: { published: number; drafted: number; waitingApproval: number; skipped: number; failed: number }
}

/** Tech full names per job for a set of job ids (sf_job_techs). */
export async function loadTechsByJob(db: SupabaseClient, jobIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  for (let i = 0; i < jobIds.length; i += 500) {
    const { data } = await db.from('sf_job_techs').select('job_id, tech_first_name, tech_last_name').in('job_id', jobIds.slice(i, i + 500))
    for (const t of (data ?? []) as Array<{ job_id: string; tech_first_name: string | null; tech_last_name: string | null }>) {
      const name = [t.tech_first_name, t.tech_last_name].filter(Boolean).join(' ').trim()
      if (name) out.set(t.job_id, [...(out.get(t.job_id) ?? []), name])
    }
  }
  return out
}

export async function loadInsights(db: SupabaseClient, window: DateWindow, photoThreshold: number): Promise<Insights> {
  const { fromIso, toIso } = window
  const [{ data: surveyRows }, { data: reviewRows }, { count: removed }, { data: photoRows }, { data: postRows }] = await Promise.all([
    db.from('csat_surveys').select('sf_job_id, sent_at, status, review_requested_at, review_link_clicked_at, survey_reminder_sent_at, review_reminder_sent_at, primary_tech_name, csat_responses(rating, is_current)')
      .eq('is_test', false).gte('sent_at', fromIso).lt('sent_at', toIso).limit(5000),
    db.from('google_reviews').select('id, star_rating, comment, created_at_google, reviewer_name, ai_sentiment, ai_themes, ai_mentioned_names, matched_job_id, match_status, reply_text, reply_updated_at, reply_source, deleted_at')
      .gte('created_at_google', fromIso).lt('created_at_google', toIso).limit(5000),
    db.from('google_reviews').select('id', { count: 'exact', head: true }).gte('deleted_at', fromIso).lt('deleted_at', toIso),
    db.from('job_photos').select(PHOTO_SELECT).gte('created_at', fromIso).lt('created_at', toIso).limit(5000),
    db.from('gbp_posts').select('status, published_at, created_at').or(`and(created_at.gte.${fromIso},created_at.lt.${toIso}),and(published_at.gte.${fromIso},published_at.lt.${toIso})`).limit(2000),
  ])

  type SurveyRaw = Omit<FunnelSurveyRow, 'rating'> & { csat_responses: Array<{ rating: number | null; is_current: boolean }> | null }
  const surveys: FunnelSurveyRow[] = ((surveyRows ?? []) as SurveyRaw[]).map(s => ({
    ...s, rating: (s.csat_responses ?? []).find(r => r.is_current)?.rating ?? null,
  }))
  type ReviewRaw = TaggedReviewRow & ReplyPerfReviewRow & { match_status: string }
  const reviews = (reviewRows ?? []) as ReviewRaw[]
  const live = reviews.filter(r => !r.deleted_at)

  // Reviews matched to jobs count for the funnel's last step; techs per job feed mentions and photos.
  const reviewedJobIds = new Set(live.filter(r => r.matched_job_id && (r.match_status === 'auto' || r.match_status === 'confirmed')).map(r => r.matched_job_id as string))
  const photos = (photoRows ?? []) as JobPhotoRow[]
  const jobIds = [...new Set([...reviewedJobIds, ...photos.map(p => p.sf_job_id)])]
  const techsByJob = await loadTechsByJob(db, jobIds)

  const { data: replyRows } = live.length
    ? await db.from('review_replies').select('google_review_id, status, sent_at, approved_by, approved_at, draft_text, final_text').in('google_review_id', live.map(r => r.id))
    : { data: [] }

  const byStar: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  for (const r of live) byStar[r.star_rating as 1 | 2 | 3 | 4 | 5]++
  const posts = { published: 0, drafted: 0, waitingApproval: 0, skipped: 0, failed: 0 }
  for (const p of (postRows ?? []) as Array<{ status: string; published_at: string | null; created_at: string }>) {
    if (p.status === 'published' && p.published_at && p.published_at >= fromIso && p.published_at < toIso) posts.published++
    if (p.created_at >= fromIso && p.created_at < toIso) {
      posts.drafted++
      if (p.status === 'draft') posts.waitingApproval++
      if (p.status === 'skipped') posts.skipped++
      if (p.status === 'failed') posts.failed++
    }
  }

  return {
    window,
    reviews: { count: live.length, avg: live.length ? Math.round(live.reduce((s, r) => s + r.star_rating, 0) / live.length * 100) / 100 : null, fives: byStar[5], ones: byStar[1], removed: removed ?? 0, byStar },
    funnel: summarizeFunnel(surveys, reviewedJobIds),
    themes: summarizeThemes(live),
    mentions: summarizeMentions(live, techsByJob),
    replies: summarizeReplies(reviews, (replyRows ?? []) as ReplyPerfReplyRow[]),
    photos: summarizePhotos(photos, techsByJob, photoThreshold),
    posts,
  }
}
