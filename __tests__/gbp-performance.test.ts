import { describe, it, expect } from 'vitest'
import { parseMultiDailyMetrics, foldDailyMetrics, sumDays, describePerformanceError, trimUnfinalized } from '@/lib/google-reviews/performance'
import { foldHistory } from '@/lib/rank/scorecard'
import { googleProfileLines } from '@/lib/notifications/templates/reputation-digest'

const sample = {
  multiDailyMetricTimeSeries: [{
    dailyMetricTimeSeries: [
      { dailyMetric: 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS', timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 1 }, value: '12' }, { date: { year: 2026, month: 9, day: 2 }, value: '7' }] } },
      { dailyMetric: 'BUSINESS_IMPRESSIONS_MOBILE_MAPS', timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 1 }, value: '30' }, { date: { year: 2026, month: 9, day: 2 } }] } },
      { dailyMetric: 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH', timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 1 }, value: '100' }] } },
      { dailyMetric: 'CALL_CLICKS', timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 2 }, value: '3' }] } },
      { dailyMetric: 'WEBSITE_CLICKS', timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 1 }, value: '4' }] } },
      { dailyMetric: 'BUSINESS_DIRECTION_REQUESTS', timeSeries: {} },
    ],
  }],
}

describe('Google performance parsing', () => {
  it('flattens the nested time series, treating a missing value as zero', () => {
    const rows = parseMultiDailyMetrics(sample)
    expect(rows).toHaveLength(7)
    expect(rows[0]).toEqual({ date: '2026-09-01', metric: 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS', value: 12 })
    expect(rows.find(r => r.metric === 'BUSINESS_IMPRESSIONS_MOBILE_MAPS' && r.date === '2026-09-02')?.value).toBe(0)
  })
  it('tolerates junk', () => {
    expect(parseMultiDailyMetrics(null)).toEqual([])
    expect(parseMultiDailyMetrics({ multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [{ timeSeries: {} }] }] })).toEqual([])
  })
  it('folds desktop and mobile into one Maps / Search number per day, sorted by day', () => {
    const days = foldDailyMetrics(parseMultiDailyMetrics(sample).reverse())
    expect(days.map(d => d.date)).toEqual(['2026-09-01', '2026-09-02'])
    expect(days[0]).toMatchObject({ impressionsMaps: 42, impressionsSearch: 100, calls: 0, website: 4, directions: 0 })
    expect(days[1]).toMatchObject({ impressionsMaps: 7, impressionsSearch: 0, calls: 3 })
    expect(sumDays(days)).toMatchObject({ impressionsMaps: 49, impressionsSearch: 100, calls: 3, website: 4 })
  })
  it('drops trailing days Google has not finalized (all zeros) but keeps zero days in the middle', () => {
    const rows = [
      { date: '2026-09-10', metric: 'CALL_CLICKS', value: 2 }, { date: '2026-09-10', metric: 'WEBSITE_CLICKS', value: 0 },
      { date: '2026-09-09', metric: 'CALL_CLICKS', value: 0 }, { date: '2026-09-09', metric: 'WEBSITE_CLICKS', value: 0 },
      { date: '2026-09-11', metric: 'CALL_CLICKS', value: 0 }, { date: '2026-09-12', metric: 'CALL_CLICKS', value: 0 },
      { date: '2026-09-08', metric: 'CALL_CLICKS', value: 1 },
    ]
    expect([...new Set(trimUnfinalized(rows).map(r => r.date))].sort()).toEqual(['2026-09-08', '2026-09-09', '2026-09-10'])
    expect(trimUnfinalized([{ date: '2026-09-12', metric: 'CALL_CLICKS', value: 0 }])).toEqual([])
    expect(trimUnfinalized([])).toEqual([])
  })
  it('explains the "API not enabled" 403 in plain words', () => {
    expect(describePerformanceError(403, '{"error":{"status":"PERMISSION_DENIED","message":"Business Profile Performance API has not been used in project 123 before or it is disabled."}}')).toMatch(/not enabled in the Google Cloud project/)
    expect(describePerformanceError(403, 'forbidden')).toMatch(/403/)
    expect(describePerformanceError(404, 'x')).toMatch(/GOOGLE_BUSINESS_LOCATION_ID/)
  })
})

describe('digest Google profile lines', () => {
  const t = { impressionsMaps: 900, impressionsSearch: 1300, calls: 14, website: 22, directions: 9, conversations: 0, bookings: 0 }
  it('compares with the week before when it exists', () => {
    const lines = googleProfileLines(t, { ...t, impressionsMaps: 800, calls: 14, website: 30 })
    expect(lines[0]).toBe('Seen 2,200 times on Google (up from 2,100) · 900 on Maps, 1,300 in Search')
    expect(lines[1]).toBe('14 calls (same as the week before) · 22 website clicks (down from 30) · 9 direction requests (same as the week before)')
    expect(lines).toHaveLength(2)
  })
  it('stands alone on the first week', () => {
    expect(googleProfileLines({ ...t, conversations: 1, bookings: 2 }, null)[0]).toBe('Seen 2,200 times on Google · 900 on Maps, 1,300 in Search')
    expect(googleProfileLines({ ...t, conversations: 1, bookings: 2 }, null)[2]).toBe('1 message · 2 bookings')
  })
})

describe('rank trend history', () => {
  it('keeps the newest scan per monitor and week, and sorts weeks oldest first', () => {
    const { weeks, points } = foldHistory([
      { monitor_id: 'a', week_key: '2026-09-07', run_at: '2026-09-07T13:00:00Z', our_rank_avg: 5, found_share: 0.8, top3_share: 0.2 },
      { monitor_id: 'a', week_key: '2026-09-07', run_at: '2026-09-09T13:00:00Z', our_rank_avg: 4, found_share: 0.9, top3_share: 0.3 },
      { monitor_id: 'a', week_key: '2026-08-31', run_at: '2026-08-31T13:00:00Z', our_rank_avg: 7, found_share: 0.6, top3_share: 0 },
      { monitor_id: 'b', week_key: null, run_at: '2026-09-02T13:00:00Z', our_rank_avg: null, found_share: 0, top3_share: 0 },
    ])
    expect(weeks).toEqual(['2026-08-31', '2026-09-02', '2026-09-07'])
    expect(points.find(p => p.monitor_id === 'a' && p.week_key === '2026-09-07')?.our_rank_avg).toBe(4)
    expect(points.find(p => p.monitor_id === 'b')).toEqual({ monitor_id: 'b', week_key: '2026-09-02', our_rank_avg: null, found_share: 0, top3_share: 0 })
    expect(points).toHaveLength(3)
  })
})
