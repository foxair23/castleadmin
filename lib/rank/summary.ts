import { bandFor, type RankResult } from './grid'

// Pure summaries over stored scans: week-over-week movement per point, the
// competitor table per keyword, and the neighborhood scorecard with its
// movement rules (PRD §8.4, §8.5). No database access here; unit-tested.

export interface PointRow { row: number; col: number; lat: number; lng: number; our_rank: number | null; results: RankResult[]; error?: string | null }

export interface PointCompare extends PointRow { previous: number | null; delta: number | null; band: ReturnType<typeof bandFor> }

/** Pair each current point with the same row/col in the previous scan. delta > 0 means we moved up (lower number). */
export function comparePoints(current: PointRow[], previous: PointRow[] | null): PointCompare[] {
  const prev = new Map((previous ?? []).map(p => [`${p.row}:${p.col}`, p.our_rank]))
  return current.map(p => {
    const before = prev.has(`${p.row}:${p.col}`) ? prev.get(`${p.row}:${p.col}`)! : null
    const delta = p.our_rank != null && before != null ? before - p.our_rank : p.our_rank != null && before == null && previous ? 21 - p.our_rank : p.our_rank == null && before != null ? -(21 - before) : null
    return { ...p, previous: before, delta, band: bandFor(p.our_rank) }
  })
}

export interface Competitor { key: string; title: string; rating: number | null; reviews: number | null; points: number; top3: number; avgRank: number; is_us: boolean }

/** Who holds the top spots across a set of points (one keyword, one or many scans). */
export function competitorTable(points: Array<{ results: RankResult[] }>, limit = 10): Competitor[] {
  const map = new Map<string, { title: string; rating: number | null; reviews: number | null; points: number; top3: number; rankSum: number; is_us: boolean }>()
  for (const p of points) {
    for (const r of p.results ?? []) {
      const key = r.place_id ?? r.cid ?? r.title.toLowerCase()
      const c = map.get(key) ?? { title: r.title, rating: r.rating, reviews: r.reviews, points: 0, top3: 0, rankSum: 0, is_us: r.is_us }
      c.points++; c.rankSum += r.rank; if (r.rank <= 3) c.top3++
      if (r.reviews != null && (c.reviews == null || r.reviews > c.reviews)) { c.reviews = r.reviews; c.rating = r.rating }
      map.set(key, c)
    }
  }
  return [...map].map(([key, c]) => ({ key, title: c.title, rating: c.rating, reviews: c.reviews, points: c.points, top3: c.top3, avgRank: Math.round(c.rankSum / c.points * 10) / 10, is_us: c.is_us }))
    .sort((a, b) => b.top3 - a.top3 || b.points - a.points || a.avgRank - b.avgRank)
    .slice(0, limit)
}

// ── Neighborhood scorecard ──────────────────────────────────────────────────

export interface ScorecardInput {
  place: { id: string; name: string; zips: string[] }
  keywords: Array<{ keyword: string; now: number | null; fourWeeksAgo: number | null; foundShare: number | null }>
  jobs90: number
  reviews90: number
  reviewsAvg: number | null
  funnel: { sent: number; reviewed: number } | null
  replies: { total: number; replied: number; within48h: number }
  areaPage: { url: string; page_updated_at: string | null } | null
  topCompetitor: { title: string; rating: number | null; reviews: number | null } | null
}
export interface ScorecardRow extends ScorecardInput { rankNow: number | null; trend: number | null; status: 'good' | 'watch' | 'act'; advice: string }

/** Movement rules (PRD §8.5): turn the numbers into the one thing to do next for this place. */
export function scorecardRow(i: ScorecardInput): ScorecardRow {
  const ranks = i.keywords.map(k => k.now).filter((n): n is number => n != null)
  const rankNow = ranks.length ? Math.round(ranks.reduce((s, r) => s + r, 0) / ranks.length * 10) / 10 : null
  const trendPairs = i.keywords.filter(k => k.now != null && k.fourWeeksAgo != null)
  const trend = trendPairs.length ? Math.round(trendPairs.reduce((s, k) => s + (k.fourWeeksAgo! - k.now!), 0) / trendPairs.length * 10) / 10 : null
  const scanned = i.keywords.length > 0
  const visible = i.keywords.some(k => k.foundShare != null && k.foundShare > 0)
  const replyRate = i.replies.total ? i.replies.replied / i.replies.total : 1
  const reviewsPerJob = i.jobs90 ? i.reviews90 / i.jobs90 : null

  let status: ScorecardRow['status'] = 'good', advice = 'Holding well. Keep the review flow steady.'
  if (!scanned) { status = 'watch'; advice = 'No keyword is monitored here yet. Add one from the monitored list to start measuring.' }
  else if (i.jobs90 >= 5 && reviewsPerJob != null && reviewsPerJob < 0.1) { status = 'act'; advice = `Busy here (${i.jobs90} jobs) but few reviews. The funnel is leaking: check survey exclusions and reminders for these ZIPs.` }
  else if (i.reviews90 >= 3 && replyRate < 0.8) { status = 'act'; advice = `${i.replies.total - i.replies.replied} of ${i.replies.total} reviews here have no reply. Answer them (the backlog button) and name the city in each reply.` }
  else if ((rankNow == null || rankNow > 10) && i.jobs90 >= 5 && !i.areaPage) { status = 'act'; advice = 'Jobs and reviews are fine but rank is weak and there is no area page. Add a page for this neighborhood on the website with jobs and photos from here.' }
  else if ((rankNow == null || rankNow > 10) && i.jobs90 >= 5 && i.areaPage && stale(i.areaPage.page_updated_at)) { status = 'act'; advice = 'Rank is weak and the area page has not been refreshed in six months. Add recent jobs and photos to it.' }
  else if (!visible && i.jobs90 >= 5) { status = 'watch'; advice = 'Not appearing at all here despite steady work. This is likely beyond the office\'s distance ceiling: evidence for a second staffed location, not a content fix.' }
  else if (rankNow != null && rankNow > 10) { status = 'watch'; advice = 'Outside the top 10. Low job volume here, so not the first place to push; keep monitoring.' }
  else if (trend != null && trend <= -2) { status = 'watch'; advice = 'Slipping over the last month. Check review recency here and that recent replies name the city.' }
  return { ...i, rankNow, trend, status, advice }
}
const stale = (iso: string | null) => !iso || Date.now() - new Date(iso).getTime() > 183 * 86_400_000

/** For the digest: average rank across all monitors this week vs last, and the biggest movers. */
export function weekMovement(thisWeek: Array<{ monitorKey: string; label: string; avgRank: number | null }>, lastWeek: Array<{ monitorKey: string; avgRank: number | null }>): { avgNow: number | null; avgBefore: number | null; up: Array<{ label: string; delta: number }>; down: Array<{ label: string; delta: number }> } {
  const before = new Map(lastWeek.map(l => [l.monitorKey, l.avgRank]))
  const avg = (xs: Array<number | null>) => { const v = xs.filter((x): x is number => x != null); return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length * 10) / 10 : null }
  const moves = thisWeek.flatMap(t => { const b = before.get(t.monitorKey); return t.avgRank != null && b != null && b !== t.avgRank ? [{ label: t.label, delta: Math.round((b - t.avgRank) * 10) / 10 }] : [] })
  return {
    avgNow: avg(thisWeek.map(t => t.avgRank)), avgBefore: avg(lastWeek.map(l => l.avgRank)),
    up: moves.filter(m => m.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 3),
    down: moves.filter(m => m.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 3),
  }
}
