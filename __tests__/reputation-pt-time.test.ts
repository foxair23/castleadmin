import { describe, it, expect } from 'vitest'
import { ptParts, ptWallToUtc, addPtDays, weekdayOf } from '@/lib/reputation/pt-time'

describe('pt-time', () => {
  it('reads Pacific wall-clock parts in PDT and PST', () => {
    const pdt = ptParts(new Date('2026-07-15T16:02:41Z')) // 9:02:41 PDT
    expect([pdt.hour, pdt.minute, pdt.second, pdt.dateKey, pdt.weekday]).toEqual([9, 2, 41, '2026-07-15', 'wed'])
    const pst = ptParts(new Date('2026-01-15T17:28:17Z')) // 9:28:17 PST
    expect([pst.hour, pst.minute, pst.dateKey, pst.weekday]).toEqual([9, 28, '2026-01-15', 'thu'])
  })
  it('round-trips wall time to an instant across both offsets', () => {
    expect(ptWallToUtc('2026-07-15', 9 * 60 + 2, 41).toISOString()).toBe('2026-07-15T16:02:41.000Z')
    expect(ptWallToUtc('2026-01-15', 9 * 60 + 28, 17).toISOString()).toBe('2026-01-15T17:28:17.000Z')
  })
  it('handles the DST transition days', () => {
    // 2026-03-08: clocks jump 2:00 → 3:00. 9:00 that morning is 16:00Z (already PDT).
    expect(ptWallToUtc('2026-03-08', 9 * 60).toISOString()).toBe('2026-03-08T16:00:00.000Z')
    // 2026-11-01: clocks fall back. 9:00 that morning is 17:00Z (PST).
    expect(ptWallToUtc('2026-11-01', 9 * 60).toISOString()).toBe('2026-11-01T17:00:00.000Z')
    // Late evening before the fall-back day is still PDT.
    expect(ptWallToUtc('2026-10-31', 18 * 60).toISOString()).toBe('2026-11-01T01:00:00.000Z')
  })
  it('does calendar arithmetic on date keys', () => {
    expect(addPtDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addPtDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(weekdayOf('2026-09-13')).toBe('sun')
    expect(weekdayOf('2026-09-14')).toBe('mon')
  })
})
