import { describe, it, expect } from 'vitest'
import { normalizeRule, newRules, MAX_FOLLOW_UPS } from '@/lib/agent/email/teach'

describe('teach helpers', () => {
  it('normalises a rule to one capitalised sentence', () => {
    expect(normalizeRule('  when a job says waiting for tiffany, ask the team in chat..  ')).toBe('When a job says waiting for tiffany, ask the team in chat.')
    expect(normalizeRule('')).toBe('')
  })
  it('keeps only rules not already on file, ignoring case and punctuation, and dedupes within the batch', () => {
    const existing = ['When a job status says waiting for Tiffany, ask the team in chat.']
    expect(newRules(['when a job status says waiting for tiffany, ask the team in chat', 'Never promise a date that has already passed.', 'never promise a date that has already passed'], existing))
      .toEqual(['Never promise a date that has already passed.'])
  })
  it('bounds the back-and-forth', () => { expect(MAX_FOLLOW_UPS).toBeGreaterThan(1); expect(MAX_FOLLOW_UPS).toBeLessThanOrEqual(6) })
})
