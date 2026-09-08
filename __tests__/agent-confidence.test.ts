import { describe, it, expect } from 'vitest'
import { computeConfidence, autoSendDecision } from '@/lib/agent/email/confidence'
import { stripDisclosure } from '@/lib/agent/email/review'
import { mergeSettings, AGENT_DEFAULTS } from '@/lib/agent/settings'

const good = { resolveStatus: 'matched' as const, resolveTier: 'po' as const, questionType: 'schedule' as const, fullyGrounded: true, unsourcedCount: 0, liveFresh: true, hardFailReasons: [] as string[] }

describe('computeConfidence', () => {
  it('a PO-matched, grounded, fresh, in-focus draft scores 1.0', () => {
    expect(computeConfidence(good, AGENT_DEFAULTS).score).toBe(1)
  })
  it('name match scores lower than PO; no match zeroes the match component', () => {
    expect(computeConfidence({ ...good, resolveTier: 'name' }, AGENT_DEFAULTS).score).toBe(0.9)
    const none = computeConfidence({ ...good, resolveStatus: 'none', resolveTier: null, hardFailReasons: ['no_match'] }, AGENT_DEFAULTS)
    expect(none.breakdown.match).toBe(0)
    expect(none.score).toBe(0.6)
  })
  it('unsourced claims collapse the grounding component', () => {
    const r = computeConfidence({ ...good, fullyGrounded: false, unsourcedCount: 2, hardFailReasons: ['ungrounded'] }, AGENT_DEFAULTS)
    expect(r.breakdown.grounding).toBe(0.2)
    expect(r.score).toBeLessThan(0.8)
  })
  it('out-of-focus question type and stale read reduce the score; human/multi penalties apply', () => {
    expect(computeConfidence({ ...good, questionType: 'pricing' }, AGENT_DEFAULTS).score).toBe(0.91)
    expect(computeConfidence({ ...good, liveFresh: false, hardFailReasons: ['refresh_failed'] }, AGENT_DEFAULTS).score).toBe(0.85)
    expect(computeConfidence({ ...good, hardFailReasons: ['asks_for_human'] }, AGENT_DEFAULTS).score).toBe(0.85)
  })
})

describe('autoSendDecision', () => {
  it('defaults block everything (auto off)', () => {
    expect(autoSendDecision(good, 1, AGENT_DEFAULTS)).toEqual({ ok: false, reasons: ['auto_off'] })
  })
  it('with auto on, a perfect PO draft in focus sends; hard fails never do', () => {
    const on = mergeSettings({ auto_respond_enabled: true })
    expect(autoSendDecision(good, 1, on)).toEqual({ ok: true, reasons: [] })
    expect(autoSendDecision({ ...good, hardFailReasons: ['ungrounded'] }, 1, on).reasons).toEqual(['ungrounded'])
    expect(autoSendDecision({ ...good, resolveTier: 'name' }, 0.95, on).reasons).toEqual(['tier_not_auto'])
    expect(autoSendDecision({ ...good, questionType: 'ship_date' }, 1, on).reasons).toEqual(['type_not_auto'])
    expect(autoSendDecision(good, 0.85, on).reasons).toEqual(['below_threshold'])
  })
  it('a paused tier blocks even a perfect draft', () => {
    const on = mergeSettings({ auto_respond_enabled: true, paused_tiers: { 'schedule:po': { since: 'x', rate: 0.3 } } })
    expect(autoSendDecision(good, 1, on).reasons).toEqual(['tier_paused'])
  })
})

describe('stripDisclosure', () => {
  it('keeps only the body for the style corpus', () => {
    const full = 'Hi Jane,\n\nFound it. Install is Tuesday.\n\nLuis is assigned.\n\nCassie\nCastle Garage Doors & Gates\n\n—\nThis answer was composed by Cassie.\nReply and a person will pick it up.'
    expect(stripDisclosure(full)).toBe('Found it. Install is Tuesday.\n\nLuis is assigned.')
  })
})
