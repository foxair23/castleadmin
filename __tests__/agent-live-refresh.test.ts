import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  refreshJob, mapLiveJob, unwrapJob, isFresh, changedFacts, isMaterialChange, clearLiveCache,
  type LiveJobFacts,
} from '@/lib/agent/live-refresh'

const RAW = {
  id: 1096589732, number: '1020259225', status: 'Scheduled', sub_status: 'Confirmed',
  customer_name: 'COOREY, MARK', po_number: '1020259181, 1020259182',
  start_date: '2026-09-10 08:00:00', end_date: '2026-09-10 12:00:00',
  time_frame_promised_start: '08:00', time_frame_promised_end: '12:00',
  completed_date: 0, closed_at: null, city: 'Escondido', postal_code: '92025',
  is_requires_follow_up: false, updated_at: '2026-09-07 10:00:00',
  techs_assigned: [{ id: 41, first_name: 'Luis', last_name: 'R' }],
  visits: [{ start_date: '2026-09-10', techs_assigned: [{ id: 41, first_name: 'Luis', last_name: 'R' }, { id: 77, first_name: 'Sam', last_name: 'K' }] }],
}

let t = 1_000_000
const now = () => t
const mkGet = (impl: () => Promise<unknown>) => vi.fn((_path: string, _params?: Record<string, string>) => impl())

beforeEach(() => { clearLiveCache(); t = 1_000_000 })

describe('mapping', () => {
  it('unwraps single, list and data shapes', () => {
    expect(unwrapJob(RAW)?.id).toBe(1096589732)
    expect(unwrapJob({ items: [RAW] })?.id).toBe(1096589732)
    expect(unwrapJob({ data: RAW })?.id).toBe(1096589732)
    expect(unwrapJob({ items: [] })).toBeNull()
    expect(unwrapJob(null)).toBeNull()
  })
  it('maps only the fields a reply may state, treating SF zeros as null', () => {
    const f = mapLiveJob(RAW, '2026-09-07T10:05:00Z')
    expect(f).toMatchObject({
      jobId: '1096589732', jobNumber: '1020259225', status: 'Scheduled', subStatus: 'Confirmed',
      startDate: '2026-09-10 08:00:00', windowStart: '08:00', windowEnd: '12:00', completedAt: null,
      poNumber: '1020259181, 1020259182', requiresFollowUp: false, fetchedAt: '2026-09-07T10:05:00Z',
    })
    expect(f.techs.map(x => x.name)).toEqual(['Luis R', 'Sam K'])
  })
  it('prefers completed_date over closed_at', () => {
    expect(mapLiveJob({ ...RAW, completed_date: '2026-09-01 15:00:00', closed_at: '2026-09-02' }).completedAt).toBe('2026-09-01 15:00:00')
    expect(mapLiveJob({ ...RAW, completed_date: 0, closed_at: '2026-09-02' }).completedAt).toBe('2026-09-02')
  })
})

describe('refreshJob', () => {
  it('reads live through the injected GET and caches', async () => {
    const get = mkGet(async () => RAW)
    const a = await refreshJob('1096589732', { get, now })
    expect(a.status).toBe('fresh')
    if (a.status === 'fresh') { expect(a.fromCache).toBe(false); expect(a.facts.status).toBe('Scheduled') }
    t += 60_000
    const b = await refreshJob('1096589732', { get, now })
    if (b.status === 'fresh') { expect(b.fromCache).toBe(true); expect(b.ageMs).toBe(60_000) }
    expect(get).toHaveBeenCalledTimes(1)
    expect(get.mock.calls[0][0]).toBe('/jobs/1096589732')
  })
  it('re-reads once the cache is older than the staleness tolerance', async () => {
    const get = mkGet(async () => RAW)
    await refreshJob('1', { get, now, stalenessMs: 5 * 60_000 })
    t += 5 * 60_000 + 1
    const r = await refreshJob('1', { get, now, stalenessMs: 5 * 60_000 })
    expect(r.status === 'fresh' && r.fromCache).toBe(false)
    expect(get).toHaveBeenCalledTimes(2)
  })
  it('force bypasses the cache (send-time re-verify)', async () => {
    const get = mkGet(async () => RAW)
    await refreshJob('1', { get, now })
    await refreshJob('1', { get, now, force: true })
    expect(get).toHaveBeenCalledTimes(2)
  })
  it('concurrent asks for the same job share one SF call', async () => {
    const get = mkGet(() => new Promise(res => setTimeout(() => res(RAW), 10)))
    const [a, b] = await Promise.all([refreshJob('1', { get, now }), refreshJob('1', { get, now })])
    expect(a.status).toBe('fresh'); expect(b.status).toBe('fresh')
    expect(get).toHaveBeenCalledTimes(1)
  })
  it('a failed read is reported as failed — never served from an older cache entry', async () => {
    let fail = false
    const get = mkGet(async () => { if (fail) throw new Error('Service Fusion API error (503) on GET /jobs/1'); return RAW })
    await refreshJob('1', { get, now })
    fail = true
    t += 10 * 60_000                      // cache expired
    const r = await refreshJob('1', { get, now })
    expect(r.status).toBe('failed')
    if (r.status === 'failed') expect(r.error).toMatch(/503/)
    const forced = await refreshJob('1', { get, now, force: true })
    expect(forced.status).toBe('failed')
  })
  it('a job SF does not know is a failure, not an empty success', async () => {
    const r = await refreshJob('999', { get: mkGet(async () => ({ items: [] })), now })
    expect(r.status).toBe('failed')
    if (r.status === 'failed') expect(r.error).toMatch(/not found/)
  })
})

describe('freshness + re-verify', () => {
  const base: LiveJobFacts = mapLiveJob(RAW, '2026-09-07T10:00:00Z')
  it('isFresh judges from fetchedAt', () => {
    const at = Date.parse('2026-09-07T10:00:00Z')
    expect(isFresh(base, 5 * 60_000, at + 4 * 60_000)).toBe(true)
    expect(isFresh(base, 5 * 60_000, at + 6 * 60_000)).toBe(false)
  })
  it('changedFacts lists only stated-fact differences', () => {
    expect(changedFacts(base, { ...base, fetchedAt: 'later', updatedAtSf: 'later', city: 'Vista' })).toEqual([])
    expect(changedFacts(base, { ...base, startDate: '2026-09-11 08:00:00', windowStart: '10:00' })).toEqual(['startDate', 'windowStart'])
    expect(changedFacts(base, { ...base, techs: [base.techs[0]] })).toEqual(['techs'])
    expect(changedFacts(base, { ...base, techs: [...base.techs].reverse() })).toEqual([])
  })
  it('material changes route to review; a window tweak alone can recompose', () => {
    expect(isMaterialChange(['windowStart'])).toBe(false)
    expect(isMaterialChange(['status'])).toBe(true)
    expect(isMaterialChange(['techs'])).toBe(true)
    expect(isMaterialChange(['startDate'])).toBe(true)
  })
})
