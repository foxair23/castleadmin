import { describe, it, expect } from 'vitest'
import { normalizeReport, trimLog, isBusy } from '@/lib/ops/extension-report'

describe('normalizeReport', () => {
  it('accepts a crawl report and strips anything credential-shaped from state', () => {
    const r = normalizeReport({ device: 'office-mac', version: '0.9.15', kind: 'crawl', site: 'genie', mode: 'full', status: 'done', started_at: 1_760_000_000_000, finished_at: 1_760_000_600_000, counts: { detailed: 3 }, state: { enabled: true, geniePass: 'nope', token: 'x', creds: { genie: true } } })
    expect(r?.kind).toBe('crawl')
    expect(r?.started_at).toMatch(/^2025|^2026/)
    expect(r?.state).toEqual({ enabled: true, creds: { genie: true } })
  })
  it('rejects non-reports', () => {
    expect(normalizeReport(null)).toBeNull()
    expect(normalizeReport({ kind: 'bogus' })).toBeNull()
    expect(normalizeReport('heartbeat')).toBeNull()
  })
  it('defaults a heartbeat to status ok with a timestamp', () => {
    const r = normalizeReport({ kind: 'heartbeat' })
    expect(r?.status).toBe('ok'); expect(r?.at).toBeTruthy(); expect(r?.device).toBe('office')
  })
})
describe('trimLog', () => {
  it('caps entries, entry length and total size', () => {
    const long = trimLog(Array.from({ length: 500 }, (_, i) => ({ i, text: 'x'.repeat(1000) })))!
    expect(long.length).toBeLessThanOrEqual(100)
    expect(JSON.stringify(long).length).toBeLessThan(20_000)
    expect(String(long[0]).length).toBeLessThanOrEqual(402)
    expect(trimLog([])).toBeNull(); expect(trimLog('nope')).toBeNull()
  })
})

// The app queues a run_now from a callback the extension makes DURING a run, so the command
// always lands on a run in progress. That is "come back in a moment", not a failure: burning
// it is what left an HD SOF Complete sub-status unwritten overnight.
describe('isBusy', () => {
  it('treats a run collision as retryable', () => {
    expect(isBusy({ ok: false, error: 'already running' })).toBe(true)
    expect(isBusy({ error: 'a run is already in progress' })).toBe(true)
    expect(isBusy({ error: 'Already Running' })).toBe(true)
  })
  it('leaves real failures alone', () => {
    expect(isBusy({ ok: false, error: 'not configured' })).toBe(false)
    expect(isBusy({ ok: false, error: 'SF session logged out' })).toBe(false)
    expect(isBusy({ ok: true })).toBe(false)
    expect(isBusy(null)).toBe(false)
    expect(isBusy('already running')).toBe(false)
  })
})
