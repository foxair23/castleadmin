import { describe, it, expect } from 'vitest'
import { normalizeJobNumber } from '@/lib/vendor-orders/link-sf-job'

// The office types job numbers the way they see them: with a '#', pasted with spaces, or
// straight from a label. Only the digits matter, and only if they look like a job number.
describe('normalizeJobNumber', () => {
  it('accepts a job number however it was typed', () => {
    expect(normalizeJobNumber('1020259248')).toBe('1020259248')
    expect(normalizeJobNumber('#1020259248')).toBe('1020259248')
    expect(normalizeJobNumber(' 1020 259 248 ')).toBe('1020259248')
    expect(normalizeJobNumber('Job #1020259248')).toBe('1020259248')
  })
  it('rejects what is not a job number', () => {
    expect(normalizeJobNumber('')).toBeNull()
    expect(normalizeJobNumber('abc')).toBeNull()
    expect(normalizeJobNumber('12345')).toBeNull()             // too short
    expect(normalizeJobNumber('1234567890123')).toBeNull()     // too long
    expect(normalizeJobNumber(null)).toBeNull()
  })
})
