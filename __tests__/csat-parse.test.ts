/**
 * CSAT rating parsing + classification (PRD §8 response handling).
 */
import { describe, it, expect } from 'vitest'
import { parseRating, classify, isLow } from '@/lib/csat/parse'

describe('parseRating — valid single 1–5', () => {
  it.each([
    ['1', 1], ['2', 2], ['3', 3], ['4', 4], ['5', 5],
    ['5!', 5], ['I give you a 5', 5], ['Rating: 4', 4],
    ['  3  ', 3],
  ])('parses %j → %d', (text, expected) => {
    expect(parseRating(text)).toBe(expected)
  })
})

describe('parseRating — invalid / ambiguous → null', () => {
  it.each([
    ['Great service'],   // no number
    ['10'],              // out of range (multi-digit)
    ['4 or 5'],          // two distinct values
    ['0'],               // below range
    ['6'],               // above range
    [''],                // empty
    ['1 and 5 both'],    // two distinct values
  ])('rejects %j', (text) => {
    expect(parseRating(text)).toBeNull()
  })

  it('accepts a repeated same digit (5 5) as unambiguous', () => {
    expect(parseRating('5 5')).toBe(5)
  })
})

describe('classify', () => {
  it('buckets ratings', () => {
    expect(classify(5)).toBe('high')
    expect(classify(4)).toBe('satisfied')
    expect(classify(3)).toBe('low')
    expect(classify(1)).toBe('low')
    expect(classify(null)).toBe('invalid')
  })
})

describe('isLow', () => {
  it('flags 1–3 as low', () => {
    expect([1, 2, 3].every(isLow)).toBe(true)
    expect([4, 5].some(isLow)).toBe(false)
    expect(isLow(null)).toBe(false)
  })
})
