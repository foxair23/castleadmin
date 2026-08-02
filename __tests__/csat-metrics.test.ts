/**
 * CSAT metric math (PRD §4 definitions + §19 dashboard acceptance).
 */
import { describe, it, expect } from 'vitest'
import { summarizeRatings } from '@/lib/csat/summary'

describe('summarizeRatings', () => {
  it('CSAT counts 4 and 5 as satisfied (PRD example: 68/80 = 85%)', () => {
    const ratings = [
      ...Array(50).fill(5),
      ...Array(18).fill(4),
      ...Array(12).fill(2),
    ] // 68 of 80 are 4–5
    const s = summarizeRatings(ratings)
    expect(s.responses).toBe(80)
    expect(s.csat).toBe(85)
    expect(s.count5).toBe(50)
    expect(s.count4).toBe(18)
    expect(s.countLow).toBe(12)
  })

  it('average rating is the mean of valid ratings', () => {
    const s = summarizeRatings([5, 5, 4, 2])
    expect(s.average).toBeCloseTo(4.0, 5)
  })

  it('distribution keys 1..5', () => {
    const s = summarizeRatings([1, 3, 3, 5])
    expect(s.distribution).toEqual({ '1': 1, '2': 0, '3': 2, '4': 0, '5': 1 })
  })

  it('empty set yields nulls, not divide-by-zero', () => {
    const s = summarizeRatings([])
    expect(s.csat).toBeNull()
    expect(s.average).toBeNull()
    expect(s.responses).toBe(0)
  })

  it('ignores out-of-range values defensively', () => {
    const s = summarizeRatings([5, 0, 7, 4])
    expect(s.responses).toBe(2)
    expect(s.csat).toBe(100)
  })
})
