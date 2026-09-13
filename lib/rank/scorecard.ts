import type { SupabaseClient } from '@supabase/supabase-js'
import { competitorTable, comparePoints, scorecardRow, weekMovement, type PointRow, type ScorecardInput, type ScorecardRow, type Competitor, type PointCompare } from './summary'
import { weekKeyFor, MONITOR_SELECT, type MonitorRow } from './scan'
import { addPtDays } from '@/lib/reputation/pt-time'

// Loaders for the Rankings sub-tab and the digest. Everything reads stored
// scans; the provider is never called from here.

export interface ScanRow { id: string; monitor_id: string | null; place_id: string | null; keyword: string; center_lat: number; center_lng: number; grid_size: number; spacing_miles: number; source: string; status: string; week_key: string | null; requests: number; cost_usd: number | null; our_rank_avg: number | null; found_share: number | null; top3_share: number | null; error: string | null; run_at: string; finished_at: string | null }
export const SCAN_SELECT = 'id, monitor_id, place_id, keyword, center_lat, center_lng, grid_size, spacing_miles, source, status, week_key, requests, cost_usd, our_rank_avg, found_share, top3_share, error, run_at, finished_at'

export interface PlaceRow { id: string; name: string; kind: string; lat: number; lng: number; zips: string[]; is_active: boolean; sort: number }

export interface MonitorOverview extends MonitorRow { latest: ScanRow | null; previous: ScanRow | null; delta: number | null; history: Array<{ week_key: string | null; our_rank_avg: number | null; found_share: number | null }> }

const n = (v: unknown): number | null => v == null ? null : Number(v)
const normScan = (s: Record<string, unknown>): ScanRow => ({ ...(s as unknown as ScanRow), our_rank_avg: n(s.our_rank_avg), found_share: n(s.found_share), top3_share: n(s.top3_share), cost_usd: n(s.cost_usd), spacing_miles: Number(s.spacing_miles) })

/** Every monitor with its latest finished scan, the one before it, and up to 12 weeks of history. */
export async function loadMonitorOverview(db: SupabaseClient): Promise<MonitorOverview[]> {
  const { data: mons } = await db.from('rank_monitors').select(MONITOR_SELECT).order('created_at')
  const monitors = (mons ?? []) as unknown as MonitorRow[]
  if (!monitors.length) return []
  const since = new Date(Date.now() - 13 * 7 * 86_400_000).toISOString()
  const { data: scans } = await db.from('rank_scans').select(SCAN_SELECT).in('monitor_id', monitors.map(m => m.id)).eq('status', 'done').gte('run_at', since).order('run_at', { ascending: false }).limit(5000)
  const byMonitor = new Map<string, ScanRow[]>()
  for (const raw of (scans ?? []) as Array<Record<string, unknown>>) { const s = normScan(raw); byMonitor.set(s.monitor_id!, [...(byMonitor.get(s.monitor_id!) ?? []), s]) }
  return monitors.map(m => {
    const list = byMonitor.get(m.id) ?? []
    const latest = list[0] ?? null
    const previous = list.find(s => latest && s.week_key !== latest.week_key) ?? null
    const delta = latest?.our_rank_avg != null && previous?.our_rank_avg != null ? Math.round((previous.our_rank_avg - latest.our_rank_avg) * 10) / 10 : null
    // One entry per week, newest first.
    const seen = new Set<string>()
    const history = list.filter(s => { const k = s.week_key ?? s.run_at.slice(0, 10); if (seen.has(k)) return false; seen.add(k); return true }).slice(0, 12).reverse().map(s => ({ week_key: s.week_key, our_rank_avg: s.our_rank_avg, found_share: s.found_share }))
    return { ...m, latest, previous, delta, history }
  })
}

export interface ScanDetail { scan: ScanRow; points: PointCompare[]; previous: ScanRow | null; competitors: Competitor[]; us: { lat: number; lng: number } | null }

/** Castle's own map position, from the first result that is us and carries coordinates. */
export function ourLocation(points: Array<{ results: PointRow['results'] }>): { lat: number; lng: number } | null {
  for (const p of points) for (const r of p.results ?? []) if (r.is_us && r.lat != null && r.lng != null) return { lat: r.lat, lng: r.lng }
  return null
}

/** One scan with its points compared to the previous finished scan of the same monitor (or same keyword+center for live checks). */
export async function loadScanDetail(db: SupabaseClient, scanId: string): Promise<ScanDetail | null> {
  const { data: raw } = await db.from('rank_scans').select(SCAN_SELECT).eq('id', scanId).maybeSingle()
  if (!raw) return null
  const scan = normScan(raw as Record<string, unknown>)
  let prevQ = db.from('rank_scans').select(SCAN_SELECT).eq('status', 'done').lt('run_at', scan.run_at).order('run_at', { ascending: false }).limit(1)
  prevQ = scan.monitor_id ? prevQ.eq('monitor_id', scan.monitor_id) : prevQ.eq('keyword', scan.keyword).eq('center_lat', scan.center_lat).eq('center_lng', scan.center_lng).eq('grid_size', scan.grid_size)
  const [{ data: pts }, { data: prevRaw }] = await Promise.all([
    db.from('rank_scan_points').select('row, col, lat, lng, our_rank, results, error').eq('scan_id', scanId).order('row').order('col'),
    prevQ.maybeSingle(),
  ])
  const previous = prevRaw ? normScan(prevRaw as Record<string, unknown>) : null
  const prevPts = previous ? (await db.from('rank_scan_points').select('row, col, lat, lng, our_rank, results, error').eq('scan_id', previous.id)).data : null
  const points = comparePoints((pts ?? []) as PointRow[], (prevPts ?? null) as PointRow[] | null)
  return { scan, points, previous, competitors: competitorTable(points), us: ourLocation(points) }
}

/** Competitor table across the latest scan of every monitor for one keyword. */
export async function loadKeywordCompetitors(db: SupabaseClient, keyword: string): Promise<{ competitors: Competitor[]; scans: number }> {
  const overview = await loadMonitorOverview(db)
  const ids = overview.filter(m => m.keyword === keyword && m.latest).map(m => m.latest!.id)
  if (!ids.length) return { competitors: [], scans: 0 }
  const { data } = await db.from('rank_scan_points').select('results').in('scan_id', ids)
  return { competitors: competitorTable((data ?? []) as Array<{ results: PointRow['results'] }>, 15), scans: ids.length }
}

/** Live checks (not tied to a monitor), newest first. */
export async function loadLiveScans(db: SupabaseClient, limit = 30): Promise<Array<ScanRow & { place_name: string | null }>> {
  const { data } = await db.from('rank_scans').select(`${SCAN_SELECT}, place:rank_places(name)`).eq('source', 'live').order('run_at', { ascending: false }).limit(limit)
  return ((data ?? []) as Array<Record<string, unknown>>).map(r => ({ ...normScan(r), place_name: ((r.place as { name: string } | null) ?? null)?.name ?? null }))
}

// ── Neighborhood scorecard ──────────────────────────────────────────────────

export async function loadScorecard(db: SupabaseClient, overview?: MonitorOverview[]): Promise<ScorecardRow[]> {
  const ov = overview ?? await loadMonitorOverview(db)
  const { data: placeRows } = await db.from('rank_places').select('id, name, kind, lat, lng, zips, is_active, sort').eq('is_active', true).order('sort').order('name')
  const places = (placeRows ?? []) as PlaceRow[]
  if (!places.length) return []
  const since90 = new Date(Date.now() - 90 * 86_400_000).toISOString()
  const allZips = [...new Set(places.flatMap(p => p.zips))]
  const [{ data: jobs }, { data: pages }] = await Promise.all([
    allZips.length ? db.from('sf_jobs').select('id, postal_code, work_completed_at').in('postal_code', allZips).gte('work_completed_at', since90).eq('is_deleted', false).not('status', 'in', '("Cancelled","Canceled","Void","Voided")').limit(10000) : Promise.resolve({ data: [] }),
    db.from('area_pages').select('place_id, url, page_updated_at'),
  ])
  const jobRows = (jobs ?? []) as Array<{ id: string; postal_code: string | null }>
  const jobIds = jobRows.map(j => j.id)
  // Chunked: a busy quarter can be thousands of jobs, more than one URL holds.
  const reviews: Array<{ matched_job_id: string; star_rating: number; reply_text: string | null; reply_updated_at: string | null; created_at_google: string }> = []
  const surveys: Array<{ sf_job_id: string }> = []
  for (let i = 0; i < jobIds.length; i += 400) {
    const ids = jobIds.slice(i, i + 400)
    const [{ data: r }, { data: sv }] = await Promise.all([
      db.from('google_reviews').select('matched_job_id, star_rating, reply_text, reply_updated_at, created_at_google').in('matched_job_id', ids).in('match_status', ['auto', 'confirmed']).is('deleted_at', null),
      db.from('csat_surveys').select('sf_job_id').in('sf_job_id', ids).eq('is_test', false).not('sent_at', 'is', null),
    ])
    reviews.push(...((r ?? []) as typeof reviews)); surveys.push(...((sv ?? []) as typeof surveys))
  }
  const pageByPlace = new Map(((pages ?? []) as Array<{ place_id: string; url: string; page_updated_at: string | null }>).map(p => [p.place_id, p]))
  // Four-weeks-ago rank per monitor from history.
  const fourWeeksKey = addPtDays(weekKeyFor(new Date()), -28)

  // Competitors per place: latest scan points of that place's monitors.
  const latestIds = ov.filter(m => m.latest).map(m => m.latest!.id)
  const { data: pts } = latestIds.length ? await db.from('rank_scan_points').select('scan_id, results').in('scan_id', latestIds) : { data: [] }
  const ptsByScan = new Map<string, Array<{ results: PointRow['results'] }>>()
  for (const p of (pts ?? []) as Array<{ scan_id: string; results: PointRow['results'] }>) ptsByScan.set(p.scan_id, [...(ptsByScan.get(p.scan_id) ?? []), p])

  return places.map(place => {
    const zipSet = new Set(place.zips)
    const myJobs = jobRows.filter(j => j.postal_code && zipSet.has(j.postal_code))
    const myJobIds = new Set(myJobs.map(j => j.id))
    const myReviews = reviews.filter(r => myJobIds.has(r.matched_job_id))
    const replied = myReviews.filter(r => r.reply_text)
    const within48 = replied.filter(r => r.reply_updated_at && new Date(r.reply_updated_at).getTime() - new Date(r.created_at_google).getTime() <= 48 * 3_600_000)
    const mySurveys = surveys.filter(s => myJobIds.has(s.sf_job_id))
    const mons = ov.filter(m => m.place_id === place.id && m.is_active)
    const keywords = mons.map(m => ({
      keyword: m.keyword, now: m.latest?.our_rank_avg ?? null,
      fourWeeksAgo: m.history.find(h => h.week_key === fourWeeksKey)?.our_rank_avg ?? (m.history.length >= 5 ? m.history[m.history.length - 5]?.our_rank_avg ?? null : null),
      foundShare: m.latest?.found_share ?? null,
    }))
    const competitorPts = mons.flatMap(m => m.latest ? ptsByScan.get(m.latest.id) ?? [] : [])
    const top = competitorTable(competitorPts, 5).find(c => !c.is_us) ?? null
    const input: ScorecardInput = {
      place: { id: place.id, name: place.name, zips: place.zips },
      keywords, jobs90: myJobs.length, reviews90: myReviews.length,
      reviewsAvg: myReviews.length ? Math.round(myReviews.reduce((s, r) => s + r.star_rating, 0) / myReviews.length * 100) / 100 : null,
      funnel: mySurveys.length ? { sent: mySurveys.length, reviewed: myReviews.length } : null,
      replies: { total: myReviews.length, replied: replied.length, within48h: within48.length },
      areaPage: pageByPlace.get(place.id) ? { url: pageByPlace.get(place.id)!.url, page_updated_at: pageByPlace.get(place.id)!.page_updated_at } : null,
      topCompetitor: top ? { title: top.title, rating: top.rating, reviews: top.reviews } : null,
    }
    return scorecardRow(input)
  })
}

/** For the digest: this week's weekly scans against last week's. */
export async function loadWeekMovement(db: SupabaseClient, weekKey: string, prevWeekKey: string): Promise<ReturnType<typeof weekMovement> & { scanned: number }> {
  const { data } = await db.from('rank_scans').select('monitor_id, keyword, week_key, our_rank_avg, place:rank_places(name)').in('week_key', [weekKey, prevWeekKey]).eq('source', 'weekly').eq('status', 'done').not('monitor_id', 'is', null)
  const rows = ((data ?? []) as Array<Record<string, unknown>>).map(r => ({ monitorKey: r.monitor_id as string, label: `${((r.place as { name: string } | null) ?? { name: '?' }).name} · ${r.keyword as string}`, week: r.week_key as string, avgRank: n(r.our_rank_avg) }))
  const cur = rows.filter(r => r.week === weekKey), prev = rows.filter(r => r.week === prevWeekKey)
  return { ...weekMovement(cur, prev), scanned: cur.length }
}
