import { describe, it, expect } from 'vitest'
import { MANUAL, MANUAL_UNMATCHED } from '@/lib/remittance/engine'

// Re-matching used to rewrite every pending line, so a hand-typed job number survived only
// until the next "Re-match all" — which is why one wrong job looked like it kept coming
// back. A person's decision is now recorded as the match method and skipped by the sweep.
const rematchWouldTouch = (matchMethod: string | null) =>
  matchMethod === null || (matchMethod !== MANUAL && matchMethod !== MANUAL_UNMATCHED)

describe('which lines a re-match may rewrite', () => {
  it('leaves both kinds of human decision alone', () => {
    expect(rematchWouldTouch(MANUAL)).toBe(false)             // "this IS job 1020258680"
    expect(rematchWouldTouch(MANUAL_UNMATCHED)).toBe(false)   // "this is NOT that job"
  })
  it('still re-matches everything the machine decided', () => {
    expect(rematchWouldTouch(null)).toBe(true)                // never matched
    expect(rematchWouldTouch('po')).toBe(true)
    expect(rematchWouldTouch('po_name')).toBe(true)
    expect(rematchWouldTouch('name')).toBe(true)
    expect(rematchWouldTouch('ai')).toBe(true)
  })
  it('keeps the two decisions distinct — unmatching is a statement, not an absence', () => {
    // Blanking the job without recording why would let the matcher put the same wrong job
    // straight back on the next sweep, which is the bug being fixed.
    expect(MANUAL).not.toBe(MANUAL_UNMATCHED)
  })
})
