import { describe, it, expect } from 'vitest'
import { transientLinesAttempt, MAX_TRANSIENT_ATTEMPTS } from '@/lib/vendor-orders/sf-lines-queue'

describe('transient line-item failures', () => {
  it('retries a search miss up to the cap, then stops', () => {
    expect(transientLinesAttempt('job 1020259213 not found in SF global search', null)).toBe(1)
    expect(transientLinesAttempt('job 1020259213 not found in SF global search', 'x — will retry (attempt 3 of 6)')).toBe(4)
    expect(transientLinesAttempt('job 1020259213 not found in SF global search', `x — will retry (attempt ${MAX_TRANSIENT_ATTEMPTS} of 6)`)).toBeNull()
  })
  it('does not retry a real refusal', () => {
    expect(transientLinesAttempt('job 1020259213 already has 3 service line(s)', null)).toBeNull()
    expect(transientLinesAttempt('save did not land on jobView (status 500)', null)).toBeNull()
  })
})
