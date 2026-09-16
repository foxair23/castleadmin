import { describe, it, expect } from 'vitest'
import { isInScope, AGENT_DEFAULTS, type AgentSettings } from '@/lib/agent/settings'

// The earliest gate in the pipeline: it runs before any Service Fusion read or model call,
// so an out-of-scope email costs nothing but the classifier that labelled it.
const s = (over: Partial<AgentSettings> = {}): AgentSettings => ({ ...AGENT_DEFAULTS, ...over })

describe('isInScope', () => {
  it('starts at status only — the office picks where to train her first', () => {
    expect(AGENT_DEFAULTS.handle_question_types).toEqual(['status'])
    expect(isInScope(s(), 'status', false).ok).toBe(true)
    expect(isInScope(s(), 'schedule', false).ok).toBe(false)
    expect(isInScope(s(), 'complaint', false).ok).toBe(false)
  })
  it('widens without a deploy', () => {
    const wide = s({ handle_question_types: ['status', 'schedule'] })
    expect(isInScope(wide, 'schedule', false).ok).toBe(true)
    expect(isInScope(wide, 'material', false).ok).toBe(false)
  })
  it('ignores an email that only tells us something, whatever type it landed in', () => {
    // "Order 181195118 has been staged for pickup on 9/23" was classified as schedule, and
    // one just like it as ship_date. Neither asks anything, so neither is hers.
    expect(isInScope(s(), 'status', true).ok).toBe(false)
    expect(isInScope(s({ handle_question_types: ['status', 'schedule'] }), 'schedule', true).ok).toBe(false)
  })
  it('still handles notifications when the office turns that off', () => {
    expect(isInScope(s({ skip_notifications: false }), 'status', true).ok).toBe(true)
  })
  it('says why, so Activity can show what she passed over', () => {
    expect(isInScope(s(), 'status', true).reason).toMatch(/nothing is being asked/)
    expect(isInScope(s(), 'pricing', false).reason).toMatch(/pricing/)
  })
  it('an empty list means she acts on nothing', () => {
    expect(isInScope(s({ handle_question_types: [] }), 'status', false).ok).toBe(false)
  })
})
