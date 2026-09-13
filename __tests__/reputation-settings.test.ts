import { describe, it, expect } from 'vitest'
import { mergeReputationSettings, normalizeWindow, bandFor, capFor, REPUTATION_DEFAULTS, DEFAULT_WORKING_WINDOW } from '@/lib/reputation/settings'

describe('mergeReputationSettings', () => {
  it('returns defaults for a missing row', () => {
    expect(mergeReputationSettings(null)).toEqual(REPUTATION_DEFAULTS)
  })
  it('coerces numeric() strings from PostgREST and ignores unknown keys', () => {
    const s = mergeReputationSettings({ reply_delay_min_hours: '1.50', skip_hour_ratio: '0.250', cap_new_replies: 12, bogus: 1 } as never)
    expect(s.reply_delay_min_hours).toBe(1.5)
    expect(s.skip_hour_ratio).toBe(0.25)
    expect(s.cap_new_replies).toBe(12)
    expect((s as unknown as Record<string, unknown>).bogus).toBeUndefined()
  })
  it('keeps explicit nulls on nullable columns and falls back on null elsewhere', () => {
    const s = mergeReputationSettings({ pre_existing_imported_at: null, autopilot_positive: null } as never)
    expect(s.pre_existing_imported_at).toBeNull()
    expect(s.autopilot_positive).toBe(false)
  })
  it('normalizes a loose working window', () => {
    const w = normalizeWindow({ mon: ['480', '1020'], tue: null, wed: [900, 600], sun: [0, 1500] })
    expect(w.mon).toEqual([480, 1020])
    expect(w.tue).toBeNull()
    expect(w.wed).toBeNull()            // close before open → closed
    expect(w.sun).toEqual([0, 1440])    // clamped
    expect(w.fri).toEqual(DEFAULT_WORKING_WINDOW.fri)
  })
})

describe('bands and caps', () => {
  it('splits 4–5 from 1–3', () => {
    expect(bandFor(5)).toBe('positive'); expect(bandFor(4)).toBe('positive')
    expect(bandFor(3)).toBe('negative'); expect(bandFor(1)).toBe('negative')
  })
  it('resolves the daily cap by kind and origin', () => {
    const s = { ...REPUTATION_DEFAULTS, cap_new_replies: 8, cap_backlog_replies: 3, cap_posts: 1 }
    expect(capFor(s, 'review_reply', 'new')).toBe(8)
    expect(capFor(s, 'review_reply', 'backlog')).toBe(3)
    expect(capFor(s, 'gbp_post', null)).toBe(1)
    expect(capFor(s, 'csat_reminder', null)).toBeNull()
  })
})
