import { describe, it, expect } from 'vitest'
import { AGENT_DEFAULTS, mergeSettings, isAllowlisted, isAutoEligible } from '@/lib/agent/settings'

describe('agent settings', () => {
  it('defaults are safe: processing and auto-respond off, empty allowlist', () => {
    expect(AGENT_DEFAULTS.processing_enabled).toBe(false)
    expect(AGENT_DEFAULTS.auto_respond_enabled).toBe(false)
    expect(AGENT_DEFAULTS.allowlist_domains).toEqual([])
    expect(AGENT_DEFAULTS.auto_match_tiers).toEqual(['po'])
  })
  it('merges a row over defaults and coerces numerics that PostgREST returns as strings', () => {
    const s = mergeSettings({ confidence_threshold: '0.850', hold_minutes: 20, reply_to_email: null, chat_space_name: 'spaces/X' })
    expect(s.confidence_threshold).toBe(0.85)
    expect(s.hold_minutes).toBe(20)
    expect(s.reply_to_email).toBeNull()
    expect(s.chat_space_name).toBe('spaces/X')
    expect(s.mailbox_address).toBe('cassie@castlegarage.com')
  })
  it('allowlist: domain + subdomain, explicit address, blocklist wins, empty = nobody', () => {
    const s = mergeSettings({ allowlist_domains: ['homedepot.com', '@Clopay.com'], allowlist_addresses: ['rep@geniecompany.com'], blocklist_addresses: ['spam@homedepot.com'] })
    expect(isAllowlisted(s, 'Store.Manager@HomeDepot.com')).toBe(true)
    expect(isAllowlisted(s, 'x@mail.homedepot.com')).toBe(true)
    expect(isAllowlisted(s, 'x@nothomedepot.com')).toBe(false)
    expect(isAllowlisted(s, 'a@clopay.com')).toBe(true)
    expect(isAllowlisted(s, 'rep@geniecompany.com')).toBe(true)
    expect(isAllowlisted(s, 'other@geniecompany.com')).toBe(false)
    expect(isAllowlisted(s, 'spam@homedepot.com')).toBe(false)
    expect(isAllowlisted(AGENT_DEFAULTS, 'anyone@homedepot.com')).toBe(false)
    expect(isAllowlisted(s, null)).toBe(false)
  })
  it('auto eligibility lists every blocking reason', () => {
    expect(isAutoEligible(AGENT_DEFAULTS, 'schedule', 'po')).toEqual({ ok: false, reasons: ['auto_off'] })
    const on = mergeSettings({ auto_respond_enabled: true, paused_tiers: { 'schedule:po': { since: 'x', rate: 0.3 } } })
    expect(isAutoEligible(on, 'schedule', 'po').reasons).toEqual(['tier_paused'])
    expect(isAutoEligible(on, 'completion', 'po').ok).toBe(true)
    expect(isAutoEligible(on, 'pricing', 'name').reasons).toEqual(['type_not_auto', 'tier_not_auto'])
  })
})
