import { describe, it, expect } from 'vitest'
import { shouldAutoQueueLines } from '@/lib/vendor-orders/sf-lines-queue'

// When an IPO lands after the SF job exists, its lines are queued for the extension without
// a button press — unless they are already on their way or already there.
describe('shouldAutoQueueLines', () => {
  it('leaves alone what is already queued or posted', () => {
    expect(shouldAutoQueueLines('queued')).toBe(false)
    expect(shouldAutoQueueLines('posted')).toBe(false)
  })
  it('takes another look at everything else — never considered, skipped, or failed', () => {
    expect(shouldAutoQueueLines(null)).toBe(true)
    expect(shouldAutoQueueLines(undefined)).toBe(true)
    expect(shouldAutoQueueLines('skipped')).toBe(true)   // e.g. "no IPO lines with revenue" — now there are
    expect(shouldAutoQueueLines('failed')).toBe(true)
  })
})
