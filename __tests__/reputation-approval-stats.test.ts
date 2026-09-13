import { describe, it, expect } from 'vitest'
import { approvalStats, type ApprovalStatRow } from '@/lib/reputation/reply-actions'

const now = new Date('2026-09-16T17:00:00Z')
const days = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString()
const row = (band: 'positive' | 'negative', d: number, edited: boolean, auto = false): ApprovalStatRow =>
  ({ band, approved_by: auto ? null : 'u1', approved_at: days(d), draft_text: 'draft', final_text: edited ? 'changed' : 'draft' })

describe('approvalStats', () => {
  it('buckets by band, window, and how the approval happened', () => {
    const s = approvalStats([
      row('positive', 1, false), row('positive', 5, true), row('positive', 45, false), row('positive', 2, false, true),
      row('negative', 10, true), row('negative', 100, false),
      { band: 'positive', approved_by: 'u1', approved_at: null, draft_text: 'x', final_text: 'x' },
    ], now)
    expect(s.positive.d30).toEqual({ unedited: 1, edited: 1, auto: 1 })
    expect(s.positive.d90).toEqual({ unedited: 2, edited: 1, auto: 1 })
    expect(s.negative.d30).toEqual({ unedited: 0, edited: 1, auto: 0 })
    expect(s.negative.d90).toEqual({ unedited: 0, edited: 1, auto: 0 })
  })
})
