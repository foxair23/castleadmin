import { describe, it, expect } from 'vitest'
import { classifySfLookupError, pickSingleRecord } from '@/lib/sf-mirror/sync-engine'

// A record missing from SF's paginated list is not a record SF no longer has. Before the
// mirror soft-deletes anything it asks SF directly; these are the two readings of the answer.
describe('classifySfLookupError', () => {
  it('reads a 404 from the mirror client as gone', () => {
    expect(classifySfLookupError(new Error('SF API error (404) on /jobs/123: {"message":"Not Found"}'))).toBe('gone')
  })
  it('treats anything else — 5xx after retries, network, 429 — as unknown, never as gone', () => {
    expect(classifySfLookupError(new Error('SF server error (503) on /jobs/123 after 3 retries'))).toBe('unknown')
    expect(classifySfLookupError(new Error('SF network error on /jobs/123: fetch failed'))).toBe('unknown')
    expect(classifySfLookupError(new Error('SF API error (403) on /jobs/123: forbidden'))).toBe('unknown')
    expect(classifySfLookupError('boom')).toBe('unknown')
  })
})

describe('pickSingleRecord', () => {
  it('accepts a bare record or a one-item list', () => {
    expect(pickSingleRecord({ id: 1087406133, number: '1020257932' })).toMatchObject({ number: '1020257932' })
    expect(pickSingleRecord({ items: [{ id: 1087406133 }] })).toMatchObject({ id: 1087406133 })
  })
  it('refuses anything ambiguous, so a bad shape can never revive the wrong row', () => {
    expect(pickSingleRecord(null)).toBeNull()
    expect(pickSingleRecord({})).toBeNull()
    expect(pickSingleRecord({ items: [] })).toBeNull()
    expect(pickSingleRecord({ items: [{ id: 1 }, { id: 2 }] })).toBeNull()
  })
})
