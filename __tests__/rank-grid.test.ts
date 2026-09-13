import { describe, it, expect } from 'vitest'
import { gridPoints, parseMapsItems, isOurListing, ourRank, scanStats, bandFor } from '@/lib/rank/grid'
import { unwrapTaskResult } from '@/lib/rank/dataforseo'
import { comparePoints, competitorTable, scorecardRow, weekMovement } from '@/lib/rank/summary'
import { weekKeyFor } from '@/lib/rank/scan'

const ESC = { lat: 33.1192, lng: -117.0864 }

describe('gridPoints', () => {
  it('size 1 is the center itself', () => {
    expect(gridPoints(ESC, 1, 1)).toEqual([{ row: 0, col: 0, lat: 33.1192, lng: -117.0864 }])
  })
  it('a 3×3 grid is centered, one mile apart, row 0 north', () => {
    const g = gridPoints(ESC, 3, 1)
    expect(g).toHaveLength(9)
    expect(g[4]).toEqual({ row: 1, col: 1, lat: 33.1192, lng: -117.0864 })
    expect(g[0].lat).toBeGreaterThan(g[8].lat)
    expect(g[0].lng).toBeLessThan(g[8].lng)
    // one mile of latitude ≈ 0.0145°
    expect(g[0].lat - g[4].lat).toBeCloseTo(1 / 69, 4)
  })
})

describe('parseMapsItems', () => {
  const items = [
    { type: 'maps_search', rank_group: 1, title: 'Precision Door', rating: { value: 4.8, votes_count: 900 }, place_id: 'p1', address: 'x' },
    { type: 'maps_search', rank_group: 2, title: 'Castle Garage Doors & Gates', rating: { value: 4.9, votes_count: '640' }, cid: '99' },
    { type: 'paid', rank_group: 3, title: 'An ad' },
    { type: 'maps_search', rank_group: 25, title: 'Too deep' },
    { title: 'No type but fine', rank_absolute: 3 },
  ]
  it('keeps organic map results, marks us, coerces numbers', () => {
    const r = parseMapsItems(items, 'castle garage')
    expect(r.map(x => x.title)).toEqual(['Precision Door', 'Castle Garage Doors & Gates', 'No type but fine'])
    expect(r[1]).toMatchObject({ rank: 2, rating: 4.9, reviews: 640, cid: '99', is_us: true })
    expect(ourRank(r)).toBe(2)
    expect(ourRank(r.filter(x => !x.is_us))).toBeNull()
  })
  it('tolerates junk', () => {
    expect(parseMapsItems(null, 'x')).toEqual([])
    expect(parseMapsItems([1, 'a', {}], 'x')).toEqual([])
  })
})

describe('isOurListing', () => {
  it('ignores case and punctuation and needs a non-empty match', () => {
    expect(isOurListing('CASTLE Garage-Doors & Gates', 'castle garage')).toBe(true)
    expect(isOurListing('Castle Rock Doors', 'castle garage')).toBe(false)
    expect(isOurListing('anything', '')).toBe(false)
  })
})

describe('unwrapTaskResult', () => {
  it('returns the first result and cost, throws on task errors', () => {
    expect(unwrapTaskResult({ status_code: 20000, tasks: [{ status_code: 20000, cost: 0.002, result: [{ items: [] }] }] })).toEqual({ result: { items: [] }, cost: 0.002 })
    expect(() => unwrapTaskResult({ status_code: 40101, status_message: 'Auth error' })).toThrow(/40101/)
    expect(() => unwrapTaskResult({ status_code: 20000, tasks: [{ status_code: 40501, status_message: 'Invalid field' }] })).toThrow(/40501/)
    expect(() => unwrapTaskResult({ status_code: 20000, tasks: [] })).toThrow(/no task/)
  })
})

describe('scanStats and bands', () => {
  it('computes averages over found points and ignores errored points', () => {
    const s = scanStats([{ our_rank: 1 }, { our_rank: 5 }, { our_rank: null }, { our_rank: 12 }, { our_rank: 2, error: 'x' }])
    expect(s).toEqual({ points: 4, found: 3, avgRank: 6, foundShare: 0.75, top3Share: 0.25, top10Share: 0.5 })
    expect([bandFor(1), bandFor(3), bandFor(4), bandFor(10), bandFor(11), bandFor(null)]).toEqual(['top3', 'top3', 'top10', 'top10', 'top20', 'none'])
  })
})

describe('comparePoints', () => {
  it('pairs by row/col and reports movement with appear/disappear as ±(21-rank)', () => {
    const cur = [{ row: 0, col: 0, lat: 0, lng: 0, our_rank: 2, results: [] }, { row: 0, col: 1, lat: 0, lng: 0, our_rank: null, results: [] }, { row: 1, col: 0, lat: 0, lng: 0, our_rank: 4, results: [] }]
    const prev = [{ row: 0, col: 0, lat: 0, lng: 0, our_rank: 5, results: [] }, { row: 0, col: 1, lat: 0, lng: 0, our_rank: 18, results: [] }, { row: 1, col: 0, lat: 0, lng: 0, our_rank: null, results: [] }]
    const c = comparePoints(cur, prev)
    expect(c.map(x => x.delta)).toEqual([3, -3, 17])
    expect(comparePoints(cur, null).map(x => x.delta)).toEqual([null, null, null])
  })
})

describe('competitorTable', () => {
  it('ranks businesses by top-3 count then points, keeps the highest review count seen', () => {
    const r = (rank: number, title: string, reviews: number, is_us = false) => ({ rank, title, rating: 4.8, reviews, place_id: title, cid: null, address: null, category: null, is_us })
    const points = [
      { results: [r(1, 'A', 100), r(2, 'Castle', 600, true), r(3, 'B', 50)] },
      { results: [r(1, 'A', 120), r(2, 'B', 50), r(7, 'Castle', 600, true)] },
    ]
    const t = competitorTable(points)
    expect(t.map(c => [c.title, c.top3, c.points, c.avgRank])).toEqual([['A', 2, 2, 1], ['B', 2, 2, 2.5], ['Castle', 1, 2, 4.5]])
    expect(t[0].reviews).toBe(120)
    expect(t[2].is_us).toBe(true)
  })
})

describe('scorecardRow', () => {
  const base = { place: { id: 'p', name: 'Vista', zips: ['92084'] }, keywords: [{ keyword: 'garage door repair', now: 4, fourWeeksAgo: 6, foundShare: 1 }], jobs90: 20, reviews90: 4, reviewsAvg: 5, funnel: null, replies: { total: 4, replied: 4, within48h: 4 }, areaPage: { url: 'u', page_updated_at: new Date().toISOString() }, topCompetitor: null }
  it('averages rank and trend, and is good when nothing is wrong', () => {
    const r = scorecardRow(base)
    expect(r.rankNow).toBe(4); expect(r.trend).toBe(2); expect(r.status).toBe('good')
  })
  it('flags a leaking funnel before anything else', () => {
    expect(scorecardRow({ ...base, reviews90: 1 }).advice).toMatch(/funnel is leaking/)
  })
  it('flags unreplied reviews', () => {
    expect(scorecardRow({ ...base, replies: { total: 4, replied: 2, within48h: 2 } }).advice).toMatch(/no reply/)
  })
  it('asks for an area page when rank is weak with steady work', () => {
    expect(scorecardRow({ ...base, keywords: [{ keyword: 'k', now: 14, fourWeeksAgo: null, foundShare: 0.5 }], areaPage: null }).advice).toMatch(/Add a page/)
    expect(scorecardRow({ ...base, keywords: [{ keyword: 'k', now: 14, fourWeeksAgo: null, foundShare: 0.5 }], areaPage: { url: 'u', page_updated_at: '2024-01-01' } }).advice).toMatch(/not been refreshed/)
  })
  it('calls out the distance ceiling when invisible despite work', () => {
    const r = scorecardRow({ ...base, keywords: [{ keyword: 'k', now: null, fourWeeksAgo: null, foundShare: 0 }] })
    expect(r.status).toBe('watch'); expect(r.advice).toMatch(/distance ceiling/)
  })
  it('asks for a monitor when nothing is scanned', () => {
    expect(scorecardRow({ ...base, keywords: [] }).advice).toMatch(/No keyword is monitored/)
  })
})

describe('weekMovement and weekKeyFor', () => {
  it('finds movers and averages', () => {
    const m = weekMovement([{ monitorKey: 'a', label: 'Vista · repair', avgRank: 3 }, { monitorKey: 'b', label: 'Poway · repair', avgRank: 9 }], [{ monitorKey: 'a', avgRank: 6 }, { monitorKey: 'b', avgRank: 5 }])
    expect(m).toEqual({ avgNow: 6, avgBefore: 5.5, up: [{ label: 'Vista · repair', delta: 3 }], down: [{ label: 'Poway · repair', delta: -4 }] })
  })
  it('week key is the Monday in Pacific time', () => {
    expect(weekKeyFor(new Date('2026-09-14T14:05:00Z'))).toBe('2026-09-14') // Monday morning PT
    expect(weekKeyFor(new Date('2026-09-14T05:00:00Z'))).toBe('2026-09-07') // still Sunday evening PT
    expect(weekKeyFor(new Date('2026-09-17T18:00:00Z'))).toBe('2026-09-14')
  })
})
