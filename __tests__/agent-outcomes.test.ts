import { describe, it, expect } from 'vitest'
import { computeConfusionRates, tiersToPause, type OutcomeRow } from '@/lib/agent/email/outcomes'
import { mergeSettings, AGENT_DEFAULTS } from '@/lib/agent/settings'

const row = (o: Partial<OutcomeRow>): OutcomeRow => ({ question_type: 'schedule', resolve_tier: 'po', approval_path: 'auto', classification: 'resolved', ...o })

describe('computeConfusionRates', () => {
  it('groups by question type + tier and counts confused, with the auto-sent subset', () => {
    const rates = computeConfusionRates([
      row({}), row({}), row({ classification: 'confused' }), row({ classification: 'new_question', approval_path: 'approved' }),
      row({ question_type: 'tech', classification: 'confused' }),
    ])
    const sched = rates.find(r => r.key === 'schedule:po')!
    expect(sched).toMatchObject({ sample: 4, confused: 1, rate: 0.25, autoSample: 3, autoConfused: 1 })
    expect(rates.find(r => r.key === 'tech:po')).toMatchObject({ sample: 1, confused: 1, rate: 1 })
    expect(rates[0].key).toBe('tech:po')   // highest rate first
  })
  it('a new question is not confusion', () => {
    expect(computeConfusionRates([row({ classification: 'new_question' })])[0].confused).toBe(0)
  })
})

describe('tiersToPause', () => {
  const rates = computeConfusionRates([
    ...Array.from({ length: 8 }, () => row({})), row({ classification: 'confused' }), row({ classification: 'confused' }),   // 2/10 = 20%
    ...Array.from({ length: 3 }, () => row({ question_type: 'tech', classification: 'confused' })),                          // 3/3 but tiny sample
  ])
  it('pauses only at or above the threshold with enough samples', () => {
    expect(tiersToPause(rates, AGENT_DEFAULTS).map(t => t.key)).toEqual(['schedule:po'])          // 20% ≥ 20%, n=10 ≥ 10
    expect(tiersToPause(rates, mergeSettings({ confusion_threshold: 0.25 })).map(t => t.key)).toEqual([])
    expect(tiersToPause(rates, mergeSettings({ confusion_min_sample: 3 })).map(t => t.key)).toEqual(['tech:po', 'schedule:po'])
  })
  it('does not re-pause an already paused tier', () => {
    expect(tiersToPause(rates, mergeSettings({ paused_tiers: { 'schedule:po': { since: 'x', rate: 0.2 } } }))).toEqual([])
  })
  it('never pauses the "no match" bucket (nothing auto-sends there anyway)', () => {
    const r = computeConfusionRates(Array.from({ length: 12 }, () => row({ resolve_tier: null, classification: 'confused' })))
    expect(tiersToPause(r, AGENT_DEFAULTS)).toEqual([])
  })
})
