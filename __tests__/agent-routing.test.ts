import { describe, it, expect } from 'vitest'
import { decideRoute, estimateAutoShare, toConfidenceInput, type RoutableReply } from '@/lib/agent/email/routing'
import { mergeSettings, AGENT_DEFAULTS } from '@/lib/agent/settings'

const good = { resolveStatus: 'matched' as const, resolveTier: 'po' as const, questionType: 'schedule' as const, fullyGrounded: true, unsourcedCount: 0, liveFresh: true, hardFailReasons: [] as string[] }
const NOW = new Date('2026-09-08T10:00:00Z')

describe('decideRoute', () => {
  it('with auto off everything is a draft, and the blocker says so', () => {
    expect(decideRoute(good, 1, AGENT_DEFAULTS, NOW)).toEqual({ status: 'draft', approval_path: null, send_after: null, blockers: ['auto_off'] })
  })
  it('with auto on, an eligible draft queues with the hold window', () => {
    const on = mergeSettings({ auto_respond_enabled: true, hold_minutes: 12 })
    expect(decideRoute(good, 0.95, on, NOW)).toEqual({ status: 'queued', approval_path: 'auto', send_after: '2026-09-08T10:12:00.000Z', blockers: [] })
  })
  it('a hard fail can never queue, whatever the threshold', () => {
    const on = mergeSettings({ auto_respond_enabled: true, confidence_threshold: 0 })
    expect(decideRoute({ ...good, hardFailReasons: ['ungrounded'] }, 1, on, NOW).status).toBe('draft')
    expect(decideRoute({ ...good, resolveStatus: 'ambiguous', hardFailReasons: ['multi_match'] }, 1, on, NOW).blockers).toEqual(['multi_match'])
  })
})

const reply = (o: Partial<RoutableReply>): RoutableReply => ({ confidence: 1, question_type: 'schedule', resolve_status: 'matched', resolve_tier: 'po', hard_fail_reasons: [], unsourced_claims: [], live_fetched_at: '2026-09-08T09:00:00Z', ...o })

describe('estimateAutoShare', () => {
  const recent = [
    reply({}),                                                         // perfect
    reply({ confidence: 0.85 }),                                       // below default 0.9
    reply({ resolve_tier: 'name', confidence: 0.9 }),                  // tier off by default
    reply({ question_type: 'ship_date', confidence: 0.91 }),           // type not auto
    reply({ hard_fail_reasons: ['ungrounded'], unsourced_claims: ['x'], confidence: 0.7 }),
  ]
  it('ignores the master switch and counts what the threshold + toggles would allow', () => {
    const e = estimateAutoShare(recent, AGENT_DEFAULTS)
    expect(e.total).toBe(5)
    expect(e.wouldAutoSend).toBe(1)
    expect(e.share).toBe(0.2)
    expect(e.blockedBy.below_threshold).toBe(2)   // the 0.85 draft and the 0.7 ungrounded one
    expect(e.blockedBy.tier_not_auto).toBe(1)
    expect(e.blockedBy.type_not_auto).toBe(1)
    expect(e.blockedBy.ungrounded).toBe(1)
  })
  it('lowering the threshold and enabling the name tier raises the share', () => {
    const e = estimateAutoShare(recent, mergeSettings({ confidence_threshold: 0.8, auto_match_tiers: ['po', 'name'] }))
    expect(e.wouldAutoSend).toBe(3)
  })
  it('toConfidenceInput reads grounding and freshness off the stored reasons', () => {
    const i = toConfidenceInput(reply({ hard_fail_reasons: ['refresh_failed'] }))
    expect(i.liveFresh).toBe(false)
    expect(i.fullyGrounded).toBe(true)
  })
})
