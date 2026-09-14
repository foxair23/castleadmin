import type { SupabaseClient } from '@supabase/supabase-js'
import { isConfigured, refreshAccessToken } from './gbp-client'

// Google Business Profile Performance API (PRD §5 item 6): daily impressions on
// Maps and Search, calls, website clicks, direction requests, conversations and
// bookings. Same OAuth connection as the review sync; the API itself has to be
// enabled once in the Google Cloud project. Google finalizes numbers a few days
// late, so the daily sync re-reads the last 30 days and upserts; days Google has
// not finalized yet come back as zeros and are dropped until they are real.

const PERF_BASE = 'https://businessprofileperformance.googleapis.com/v1'

export const PERF_METRICS = [
  'BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 'BUSINESS_IMPRESSIONS_MOBILE_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
  'CALL_CLICKS', 'WEBSITE_CLICKS', 'BUSINESS_DIRECTION_REQUESTS', 'BUSINESS_CONVERSATIONS', 'BUSINESS_BOOKINGS',
] as const
export type PerfMetric = typeof PERF_METRICS[number]

export interface DailyMetricRow { date: string; metric: string; value: number }

/** Pure: the API's nested time series → flat rows. Tolerant of missing pieces. */
export function parseMultiDailyMetrics(json: unknown): DailyMetricRow[] {
  const out: DailyMetricRow[] = []
  const root = (json ?? {}) as Record<string, unknown>
  const multi = Array.isArray(root.multiDailyMetricTimeSeries) ? root.multiDailyMetricTimeSeries : []
  for (const m of multi as Array<Record<string, unknown>>) {
    const list = Array.isArray(m.dailyMetricTimeSeries) ? m.dailyMetricTimeSeries : []
    for (const d of list as Array<Record<string, unknown>>) {
      const metric = typeof d.dailyMetric === 'string' ? d.dailyMetric : null
      const ts = (d.timeSeries ?? {}) as Record<string, unknown>
      const dated = Array.isArray(ts.datedValues) ? ts.datedValues : []
      if (!metric) continue
      for (const dv of dated as Array<Record<string, unknown>>) {
        const dt = (dv.date ?? {}) as Record<string, unknown>
        const y = Number(dt.year), mo = Number(dt.month), da = Number(dt.day)
        if (!y || !mo || !da) continue
        const value = dv.value == null ? 0 : Number(dv.value)
        out.push({ date: `${y}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`, metric, value: Number.isFinite(value) ? value : 0 })
      }
    }
  }
  return out
}

/** Turn a Google error body into one sentence the office can act on. */
export function describePerformanceError(status: number, body: string): string {
  if (status === 403 && /has not been used|is disabled|not enabled|SERVICE_DISABLED|accessNotConfigured/i.test(body)) {
    return 'The Business Profile Performance API is not enabled in the Google Cloud project. Enable it (APIs & Services → Library → "Business Profile Performance API") with the same project the review sync uses, then try again.'
  }
  if (status === 403) return 'Google refused the request (403). The connected account may lack access to this location, or the OAuth scope does not cover performance data.'
  if (status === 401) return 'Google rejected the login token (401). The review sync connection needs to be re-authorized.'
  if (status === 404) return 'Google could not find the location (404). Check GOOGLE_BUSINESS_LOCATION_ID.'
  return `Google Performance API error ${status}: ${body.slice(0, 200)}`
}

const ymd = (d: Date) => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() })

/** One request for every metric over a date range (inclusive, calendar days). */
export async function fetchDailyMetrics(start: Date, end: Date): Promise<DailyMetricRow[]> {
  if (!isConfigured()) throw new Error('Google Business Profile is not connected (GOOGLE_* environment variables).')
  const token = await refreshAccessToken()
  const loc = process.env.GOOGLE_BUSINESS_LOCATION_ID!.replace(/^\/+/, '')
  const url = new URL(`${PERF_BASE}/${loc}:fetchMultiDailyMetricsTimeSeries`)
  for (const m of PERF_METRICS) url.searchParams.append('dailyMetrics', m)
  const s = ymd(start), e = ymd(end)
  url.searchParams.set('dailyRange.startDate.year', String(s.year)); url.searchParams.set('dailyRange.startDate.month', String(s.month)); url.searchParams.set('dailyRange.startDate.day', String(s.day))
  url.searchParams.set('dailyRange.endDate.year', String(e.year)); url.searchParams.set('dailyRange.endDate.month', String(e.month)); url.searchParams.set('dailyRange.endDate.day', String(e.day))
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(45_000) })
  const text = await res.text()
  if (!res.ok) throw new Error(describePerformanceError(res.status, text))
  let json: unknown
  try { json = JSON.parse(text) } catch { throw new Error('Google returned a non-JSON performance response') }
  return parseMultiDailyMetrics(json)
}

/** Pure: Google reports a day it has not finalized yet as all zeros. Drop those trailing days so they are neither stored nor drawn as a false drop. */
export function trimUnfinalized(rows: DailyMetricRow[]): DailyMetricRow[] {
  const totals = new Map<string, number>()
  for (const r of rows) totals.set(r.date, (totals.get(r.date) ?? 0) + r.value)
  const dates = [...totals.keys()].sort()
  let lastReal = dates.length - 1
  while (lastReal >= 0 && (totals.get(dates[lastReal]) ?? 0) === 0) lastReal--
  const keep = new Set(dates.slice(0, lastReal + 1))
  return rows.filter(r => keep.has(r.date))
}

export interface PerfSyncReport { ok: boolean; days: number; rows: number; error?: string; runId?: string }

async function upsertRows(db: SupabaseClient, rows: DailyMetricRow[]): Promise<void> {
  const loc = process.env.GOOGLE_BUSINESS_LOCATION_ID!.replace(/^\/+/, '')
  const now = new Date().toISOString()
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from('gbp_daily_metrics').upsert(rows.slice(i, i + 500).map(r => ({ location_id: loc, date: r.date, metric: r.metric, value: r.value, fetched_at: now })), { onConflict: 'location_id,date,metric' })
    if (error) throw new Error(error.message)
  }
}

/** Google finalizes a day about three days late; the newest day worth asking for. */
const latestFinalDay = () => new Date(Date.now() - 3 * 86_400_000)

/** Re-read the last `days` days (Google backfills late) and upsert. Records a run row either way. */
export async function syncPerformance(db: SupabaseClient, opts: { days?: number } = {}): Promise<PerfSyncReport> {
  const days = opts.days ?? 30
  const { data: run } = await db.from('gbp_performance_runs').insert({ status: 'running', days }).select('id').single()
  const runId = (run as { id: string } | null)?.id
  const finish = async (patch: Record<string, unknown>) => { if (runId) await db.from('gbp_performance_runs').update({ ...patch, finished_at: new Date().toISOString() }).eq('id', runId) }
  try {
    const end = latestFinalDay()
    const start = new Date(end.getTime() - (days - 1) * 86_400_000)
    const rows = trimUnfinalized(await fetchDailyMetrics(start, end))
    await upsertRows(db, rows)
    // A day stored as zeros before Google finalized it is overwritten by the upsert above once real numbers arrive.
    await finish({ status: 'done', rows_written: rows.length, error: null })
    return { ok: true, days, rows: rows.length, runId }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await finish({ status: 'failed', error: msg.slice(0, 500) })
    return { ok: false, days, rows: 0, error: msg, runId }
  }
}

/** One-time pull of everything Google keeps (about 18 months), in 90-day requests, oldest first. */
export async function backfillPerformance(db: SupabaseClient, opts: { months?: number; deadline?: number } = {}): Promise<PerfSyncReport & { from?: string; to?: string; requests?: number }> {
  const months = opts.months ?? 18
  const end = latestFinalDay()
  const start = new Date(end); start.setUTCMonth(start.getUTCMonth() - months); start.setUTCDate(start.getUTCDate() + 1)
  const totalDays = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1
  const { data: run } = await db.from('gbp_performance_runs').insert({ status: 'running', days: totalDays }).select('id').single()
  const runId = (run as { id: string } | null)?.id
  const finish = async (patch: Record<string, unknown>) => { if (runId) await db.from('gbp_performance_runs').update({ ...patch, finished_at: new Date().toISOString() }).eq('id', runId) }
  let rows = 0, requests = 0
  try {
    let all: DailyMetricRow[] = []
    for (let s = new Date(start); s <= end; s = new Date(s.getTime() + 90 * 86_400_000)) {
      if (opts.deadline && Date.now() > opts.deadline) throw new Error('Ran out of time; press the button again to continue')
      const e = new Date(Math.min(s.getTime() + 89 * 86_400_000, end.getTime()))
      all = all.concat(await fetchDailyMetrics(s, e)); requests++
    }
    const kept = trimUnfinalized(all)
    await upsertRows(db, kept); rows = kept.length
    await finish({ status: 'done', rows_written: rows, error: null })
    return { ok: true, days: totalDays, rows, runId, requests, from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await finish({ status: 'failed', rows_written: rows, error: msg.slice(0, 500) })
    return { ok: false, days: totalDays, rows, error: msg, runId, requests }
  }
}

// ── Reading it back ─────────────────────────────────────────────────────────

export interface PerfDay { date: string; impressionsMaps: number; impressionsSearch: number; calls: number; website: number; directions: number; conversations: number; bookings: number }
export interface PerfSummary { days: PerfDay[]; totals: Omit<PerfDay, 'date'>; lastFetchedAt: string | null; lastError: string | null }

/** Pure: metric rows → one row per day with the metrics folded into the columns the reports use. */
export function foldDailyMetrics(rows: DailyMetricRow[]): PerfDay[] {
  const map = new Map<string, PerfDay>()
  for (const r of rows) {
    const d = map.get(r.date) ?? { date: r.date, impressionsMaps: 0, impressionsSearch: 0, calls: 0, website: 0, directions: 0, conversations: 0, bookings: 0 }
    switch (r.metric) {
      case 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS': case 'BUSINESS_IMPRESSIONS_MOBILE_MAPS': d.impressionsMaps += r.value; break
      case 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH': case 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH': d.impressionsSearch += r.value; break
      case 'CALL_CLICKS': d.calls += r.value; break
      case 'WEBSITE_CLICKS': d.website += r.value; break
      case 'BUSINESS_DIRECTION_REQUESTS': d.directions += r.value; break
      case 'BUSINESS_CONVERSATIONS': d.conversations += r.value; break
      case 'BUSINESS_BOOKINGS': d.bookings += r.value; break
    }
    map.set(r.date, d)
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date))
}

export function sumDays(days: PerfDay[]): Omit<PerfDay, 'date'> {
  const t = { impressionsMaps: 0, impressionsSearch: 0, calls: 0, website: 0, directions: 0, conversations: 0, bookings: 0 }
  for (const d of days) { t.impressionsMaps += d.impressionsMaps; t.impressionsSearch += d.impressionsSearch; t.calls += d.calls; t.website += d.website; t.directions += d.directions; t.conversations += d.conversations; t.bookings += d.bookings }
  return t
}

/** Stored metrics for a calendar-day range (inclusive), plus the last sync's outcome. */
export async function loadPerformance(db: SupabaseClient, fromDate: string, toDate: string): Promise<PerfSummary> {
  const [{ data: rows }, { data: runs }] = await Promise.all([
    db.from('gbp_daily_metrics').select('date, metric, value').gte('date', fromDate).lte('date', toDate).limit(5000),
    db.from('gbp_performance_runs').select('status, finished_at, error').order('started_at', { ascending: false }).limit(1),
  ])
  const days = foldDailyMetrics(trimUnfinalized((rows ?? []) as DailyMetricRow[]))
  const last = ((runs ?? []) as Array<{ status: string; finished_at: string | null; error: string | null }>)[0]
  return { days, totals: sumDays(days), lastFetchedAt: last?.status === 'done' ? last.finished_at : null, lastError: last?.status === 'failed' ? last.error : null }
}
