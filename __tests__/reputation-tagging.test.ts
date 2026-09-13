import { describe, it, expect } from 'vitest'
import { normalizeTags } from '@/lib/reputation/tagging'

describe('normalizeTags', () => {
  it('keeps only known values, dedupes, trims, and caps', () => {
    const t = normalizeTags({
      sentiment: 'positive',
      themes: ['punctuality', 'bogus', 'punctuality', 'cleanliness'],
      service_tags: ['spring_replacement', 'nope'],
      mentioned_names: ['  Danny ', 'danny', 'Sarah J.', ''],
      neighborhood: '  Rancho Bernardo ',
    })
    expect(t).toEqual({ sentiment: 'positive', themes: ['punctuality', 'cleanliness'], service_tags: ['spring_replacement'], mentioned_names: ['Danny', 'Sarah J.'], neighborhood: 'Rancho Bernardo' })
  })
  it('falls back to neutral and empties on garbage', () => {
    expect(normalizeTags(null)).toEqual({ sentiment: 'neutral', themes: [], service_tags: [], mentioned_names: [], neighborhood: null })
    expect(normalizeTags({ sentiment: 'angry', themes: 'x', neighborhood: 42 })).toMatchObject({ sentiment: 'neutral', themes: [], neighborhood: null })
  })
  it('caps long lists', () => {
    const t = normalizeTags({ mentioned_names: Array.from({ length: 30 }, (_, i) => `Name${i}`) })
    expect(t.mentioned_names).toHaveLength(10)
  })
})
