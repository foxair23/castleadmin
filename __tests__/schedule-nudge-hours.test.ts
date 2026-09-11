import { describe, it, expect } from 'vitest'
import { isNudgeSendTime } from '@/lib/vendor-orders/schedule-nudge'

// The nudge cron runs every 15 minutes, all day. Sends are held to 8am–7pm Pacific.
describe('isNudgeSendTime', () => {
  // September: PDT = UTC−7.
  it('sends during the Pacific day', () => {
    expect(isNudgeSendTime(new Date('2026-09-11T15:00:00Z'))).toBe(true)   // 8:00am PT
    expect(isNudgeSendTime(new Date('2026-09-11T20:30:00Z'))).toBe(true)   // 1:30pm PT
    expect(isNudgeSendTime(new Date('2026-09-12T01:45:00Z'))).toBe(true)   // 6:45pm PT
  })
  it('holds overnight', () => {
    expect(isNudgeSendTime(new Date('2026-09-11T14:59:00Z'))).toBe(false)  // 7:59am PT
    expect(isNudgeSendTime(new Date('2026-09-12T02:00:00Z'))).toBe(false)  // 7:00pm PT
    expect(isNudgeSendTime(new Date('2026-09-12T07:00:00Z'))).toBe(false)  // midnight PT
  })
  it('follows Pacific time across the DST change', () => {
    // January: PST = UTC−8. 15:00Z is 7am PT — too early; 16:00Z is 8am.
    expect(isNudgeSendTime(new Date('2026-01-15T15:00:00Z'))).toBe(false)
    expect(isNudgeSendTime(new Date('2026-01-15T16:00:00Z'))).toBe(true)
  })
})
