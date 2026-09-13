import type { SupabaseClient } from '@supabase/supabase-js'
import { gridPoints, ourRank, scanStats, type LatLng, type RankResult } from './grid'
import { mapsSearch, isRankProviderConfigured } from './dataforseo'
import { loadReputationSettings, type ReputationSettings } from '@/lib/reputation/settings'
import { ptDateKey, addPtDays, weekdayOf } from '@/lib/reputation/pt-time'
import { WEEKDAYS } from '@/lib/reputation/settings'

// One scan = one keyword from one center, optionally a mini-grid. Every point
// is stored with the top 20 businesses, so the competitor table and the
// week-over-week compare read from rows, never from the provider again.

export interface ScanRequest {
  keyword: string; center: LatLng; gridSize: number; spacingMiles: number
  source: 'weekly' | 'live'; monitorId?: string | null; placeId?: string | null; weekKey?: string | null
}
export interface ScanOutcome { scanId: string; status: 'done' | 'failed'; requests: number; cost: number; avgRank: number | null; foundShare: number; top3Share: number; error?: string }

/** Monday (PT) of the week containing dateKey. */
export function weekKeyFor(d: Date): string {
  const key = ptDateKey(d)
  const dow = WEEKDAYS.indexOf(weekdayOf(key)) // 0 = Sunday
  return addPtDays(key, dow === 0 ? -6 : 1 - dow)
}

export async function runScan(db: SupabaseClient, req: ScanRequest, settings?: ReputationSettings, opts: { deadline?: number } = {}): Promise<ScanOutcome> {
  const s = settings ?? await loadReputationSettings(db)
  const points = gridPoints(req.center, req.gridSize, req.spacingMiles)
  const { data: scan, error: insErr } = await db.from('rank_scans').insert({
    monitor_id: req.monitorId ?? null, place_id: req.placeId ?? null, keyword: req.keyword.trim(),
    center_lat: req.center.lat, center_lng: req.center.lng, grid_size: points.length === 1 ? 1 : req.gridSize, spacing_miles: req.spacingMiles,
    source: req.source, status: 'running', week_key: req.weekKey ?? weekKeyFor(new Date()),
  }).select('id').single()
  if (insErr || !scan) throw new Error(insErr?.message ?? 'could not create scan')
  const scanId = scan.id as string

  let requests = 0, cost = 0, firstError: string | null = null
  const rows: Array<{ scan_id: string; row: number; col: number; lat: number; lng: number; our_rank: number | null; results: RankResult[]; error: string | null }> = []
  const configured = isRankProviderConfigured()
  if (!configured) firstError = 'DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set'
  for (const p of points) {
    if (!configured) { rows.push({ scan_id: scanId, row: p.row, col: p.col, lat: p.lat, lng: p.lng, our_rank: null, results: [], error: firstError }); continue }
    if (opts.deadline && Date.now() > opts.deadline) { rows.push({ scan_id: scanId, row: p.row, col: p.col, lat: p.lat, lng: p.lng, our_rank: null, results: [], error: 'out of time' }); continue }
    try {
      const r = await mapsSearch({ keyword: req.keyword, lat: p.lat, lng: p.lng, match: s.rank_business_match })
      requests++; cost += r.cost
      rows.push({ scan_id: scanId, row: p.row, col: p.col, lat: p.lat, lng: p.lng, our_rank: ourRank(r.results), results: r.results, error: null })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      requests++
      firstError ??= msg
      rows.push({ scan_id: scanId, row: p.row, col: p.col, lat: p.lat, lng: p.lng, our_rank: null, results: [], error: msg })
    }
  }
  if (rows.length) await db.from('rank_scan_points').insert(rows)
  const stats = scanStats(rows)
  const status: 'done' | 'failed' = stats.points > 0 ? 'done' : 'failed'
  await db.from('rank_scans').update({
    status, requests, cost_usd: Math.round(cost * 10000) / 10000, our_rank_avg: stats.avgRank, found_share: stats.foundShare, top3_share: stats.top3Share,
    error: status === 'failed' ? firstError : null, finished_at: new Date().toISOString(),
  }).eq('id', scanId)
  return { scanId, status, requests, cost, avgRank: stats.avgRank, foundShare: stats.foundShare, top3Share: stats.top3Share, error: status === 'failed' ? firstError ?? undefined : undefined }
}

export interface MonitorRow { id: string; place_id: string; keyword: string; grid_size: number; spacing_miles: number; is_active: boolean; place: { id: string; name: string; lat: number; lng: number; is_active: boolean } | null }
export const MONITOR_SELECT = 'id, place_id, keyword, grid_size, spacing_miles, is_active, created_at, place:rank_places(id, name, kind, lat, lng, zips, is_active)'

export interface WeeklyReport { weekKey: string; monitors: number; scanned: number; skipped: number; requests: number; cost: number; reason?: string; errors: string[] }

/** The Monday pass: every active monitor not yet scanned this week, within the weekly request cap. */
export async function runWeeklyScans(db: SupabaseClient, opts: { now?: Date; deadline?: number; force?: boolean } = {}): Promise<WeeklyReport> {
  const now = opts.now ?? new Date()
  const weekKey = weekKeyFor(now)
  const settings = await loadReputationSettings(db)
  const report: WeeklyReport = { weekKey, monitors: 0, scanned: 0, skipped: 0, requests: 0, cost: 0, errors: [] }
  if (!settings.rank_scans_enabled && !opts.force) return { ...report, reason: 'disabled' }
  if (!isRankProviderConfigured()) return { ...report, reason: 'provider_not_configured' }

  const { data } = await db.from('rank_monitors').select(MONITOR_SELECT).eq('is_active', true).order('created_at')
  const monitors = ((data ?? []) as unknown as MonitorRow[]).filter(m => m.place && m.place.is_active)
  report.monitors = monitors.length
  const { data: done } = await db.from('rank_scans').select('monitor_id, requests').eq('week_key', weekKey).eq('source', 'weekly').eq('status', 'done')
  const doneIds = new Set(((done ?? []) as Array<{ monitor_id: string | null }>).map(d => d.monitor_id).filter(Boolean))
  let used = ((done ?? []) as Array<{ requests: number }>).reduce((s, d) => s + (d.requests ?? 0), 0)

  for (const m of monitors) {
    if (doneIds.has(m.id)) { report.skipped++; continue }
    const need = m.grid_size * m.grid_size
    if (used + need > settings.rank_weekly_request_cap) { report.skipped++; report.reason ??= 'weekly_cap'; continue }
    if (opts.deadline && Date.now() > opts.deadline) { report.skipped++; report.reason ??= 'out_of_time'; continue }
    try {
      const r = await runScan(db, { keyword: m.keyword, center: { lat: m.place!.lat, lng: m.place!.lng }, gridSize: m.grid_size, spacingMiles: Number(m.spacing_miles), source: 'weekly', monitorId: m.id, placeId: m.place_id, weekKey }, settings, { deadline: opts.deadline })
      used += r.requests; report.requests += r.requests; report.cost += r.cost
      if (r.status === 'done') report.scanned++; else { report.skipped++; if (r.error) report.errors.push(`${m.place!.name} / ${m.keyword}: ${r.error}`) }
    } catch (e) {
      report.skipped++; report.errors.push(`${m.place!.name} / ${m.keyword}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return report
}
