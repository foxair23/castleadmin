import { describe, it, expect } from 'vitest'
import { repliesMatch } from '@/lib/reputation/verify'

describe('repliesMatch', () => {
  it('ignores whitespace and smart punctuation', () => {
    expect(repliesMatch('Thanks,  Sarah — we’re glad.\n\n— Castle team', "Thanks, Sarah - we're glad.\n— Castle team")).toBe(true)
  })
  it('is false for different text or missing sides', () => {
    expect(repliesMatch('a', 'b')).toBe(false)
    expect(repliesMatch(null, 'a')).toBe(false)
    expect(repliesMatch('a', null)).toBe(false)
  })
})
