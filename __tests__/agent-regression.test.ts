import { describe, it, expect } from 'vitest'
import { similarity, missingValues, scoreCase, detectDrift } from '@/lib/agent/email/regression'

describe('scoring', () => {
  const expected = 'PO 1020259181 is scheduled for installation Tuesday, September 8 with an arrival window of 8:00 AM to 12:00 PM. Luis Ramirez is the assigned technician.'
  it('a faithful rewording with the same facts passes', () => {
    const produced = 'Found it. PO 1020259181 is set for install on Tuesday, September 8th, arrival between 8:00 AM and 12:00 PM. Luis Ramirez is assigned.'
    const r = scoreCase(expected, produced, true, [])
    expect(r.missing_values).toEqual([])
    expect(r.passed).toBe(true)
    expect(r.score).toBeGreaterThan(0.9)
  })
  it('a reply missing a fact fails even when grounded', () => {
    const produced = 'PO 1020259181 is scheduled for Tuesday, September 8.'
    const r = scoreCase(expected, produced, true, [])
    expect(r.missing_values).toEqual(expect.arrayContaining(['8:00 AM', '12:00 PM', 'Luis Ramirez']))
    expect(r.passed).toBe(false)
  })
  it('an ungrounded reply fails regardless of wording', () => {
    const r = scoreCase(expected, expected, false, ['"Thursday" in: …'])
    expect(r.passed).toBe(false)
    expect(r.score).toBeLessThan(0.6)
  })
  it('similarity is token jaccard', () => {
    expect(similarity('the install is Tuesday', 'the install is Tuesday')).toBe(1)
    expect(similarity('abc def', 'xyz')).toBe(0)
  })
  it('missingValues tolerates ordinals and split dates', () => {
    expect(missingValues('Tuesday, September 8 at 8 AM', 'On Tuesday September 8th at 8 AM we arrive')).toEqual([])
  })
})

describe('detectDrift', () => {
  const pts = (vals: number[]) => vals.map((v, i) => ({ week: `w${i}`, editRate: v, confusionRate: null, drafts: 10 }))
  it('needs at least six weeks', () => {
    expect(detectDrift(pts([0.1, 0.1, 0.3]), 'editRate').drifting).toBe(false)
  })
  it('flags a sustained rise of 10 points over the prior four weeks', () => {
    expect(detectDrift(pts([0.1, 0.1, 0.1, 0.1, 0.25, 0.25]), 'editRate')).toMatchObject({ drifting: true, recent: 0.25, baseline: 0.1 })
    expect(detectDrift(pts([0.1, 0.1, 0.1, 0.1, 0.15, 0.12]), 'editRate').drifting).toBe(false)
  })
  it('one bad week is not drift', () => {
    expect(detectDrift(pts([0.1, 0.1, 0.1, 0.1, 0.1, 0.4]), 'editRate').drifting).toBe(true)   // 0.25 avg ≥ 0.2 — but two-week average smooths a single spike less than…
    expect(detectDrift(pts([0.1, 0.1, 0.1, 0.1, 0.1, 0.25]), 'editRate').drifting).toBe(false)
  })
})
