/**
 * Job completion-status classification — drives the auto-reset of premature
 * completions (a job stamped complete whose status later reverted).
 */
import { describe, it, expect } from 'vitest'
import { isCompletedish, isRevertedCandidateStatus } from '@/lib/sf-mirror/completion-status'

describe('isCompletedish', () => {
  it.each(['Completed', 'completed', 'Invoiced', 'Paid', 'Partially Paid', 'INVOICED'])(
    'treats %j as completed-ish', s => expect(isCompletedish(s)).toBe(true),
  )
  it.each(['Waiting on Parts', 'Scheduled', 'Unscheduled', 'In Progress', '', null, undefined])(
    'treats %j as NOT completed-ish', s => expect(isCompletedish(s as string | null)).toBe(false),
  )
})

describe('isRevertedCandidateStatus', () => {
  it('flags an open status (a reverted job) for reset', () => {
    expect(isRevertedCandidateStatus('waiting on parts')).toBe(true)
    expect(isRevertedCandidateStatus('Scheduled')).toBe(true)
    expect(isRevertedCandidateStatus('Unscheduled')).toBe(true)
  })
  it('does NOT flag completed-ish statuses (those are genuinely done)', () => {
    expect(isRevertedCandidateStatus('Completed')).toBe(false)
    expect(isRevertedCandidateStatus('Invoiced')).toBe(false)
    expect(isRevertedCandidateStatus('Paid')).toBe(false)
  })
  it('does NOT flag cancelled/void (never recognized either way)', () => {
    expect(isRevertedCandidateStatus('Cancelled')).toBe(false)
    expect(isRevertedCandidateStatus('canceled')).toBe(false)
    expect(isRevertedCandidateStatus('Void')).toBe(false)
    expect(isRevertedCandidateStatus('Voided')).toBe(false)
  })
  it('does NOT flag empty/unknown status (no signal to act on)', () => {
    expect(isRevertedCandidateStatus('')).toBe(false)
    expect(isRevertedCandidateStatus(null)).toBe(false)
    expect(isRevertedCandidateStatus(undefined)).toBe(false)
  })
})
