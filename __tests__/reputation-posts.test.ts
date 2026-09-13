import { describe, it, expect } from 'vitest'
import { categoryAllowed } from '@/lib/reputation/post-drafter'

describe('categoryAllowed', () => {
  it('uses the allow-list when set, else excludes the usual non-work categories', () => {
    expect(categoryAllowed('Garage Door Install', [])).toBe(true)
    expect(categoryAllowed('Warranty', [])).toBe(false)
    expect(categoryAllowed('Service Call', [])).toBe(false)
    expect(categoryAllowed('Estimate', [])).toBe(false)
    expect(categoryAllowed(null, [])).toBe(false)
    expect(categoryAllowed('Service Call', ['service call'])).toBe(true)
    expect(categoryAllowed('Garage Door Install', ['Gate Install'])).toBe(false)
  })
})
