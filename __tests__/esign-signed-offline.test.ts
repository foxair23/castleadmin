import { describe, it, expect } from 'vitest'
import { signState } from '@/lib/esign/transitions'

// The customer signed the paper form in front of the technician. Every message stops, but
// this is NOT a cancellation: Home Depot still wants the sheet in Clopay, so it stays on
// that list. The sweeps need no change — none of them select this status — so what has to
// hold is the link a customer may still be holding in their inbox.
const doc = (status: string, o: Record<string, unknown> = {}) => ({ status, customer_signed_at: null, tech_signed_at: null, ...o } as Parameters<typeof signState>[0])

describe('signState once a form is signed on paper', () => {
  it('shuts both links, so a second signature cannot land on the same form', () => {
    expect(signState(doc('signed_offline'), 'customer')).toBe('cancelled')
    expect(signState(doc('signed_offline'), 'tech')).toBe('cancelled')
  })
  it('leaves the live states alone', () => {
    expect(signState(doc('sent_customer'), 'customer')).toBe('ready')
    expect(signState(doc('prepared'), 'customer')).toBe('ready')
    expect(signState(doc('customer_signed'), 'tech')).toBe('ready')
    expect(signState(doc('sent_customer'), 'tech')).toBe('waiting_customer')
  })
  it('still reads as closed once cancelled, which is the other way to stop it', () => {
    expect(signState(doc('cancelled'), 'customer')).toBe('cancelled')
  })
})

// The "In process" list sorts by how long each one has been waiting, so the oldest is the
// one to chase. The clock read lives in lib rather than the page because the React purity
// lint refuses one during render, even server-side.
import { daysSinceIso } from '@/lib/esign/eligibility'

describe('daysSinceIso', () => {
  const now = Date.parse('2026-09-16T18:00:00Z')
  it('counts whole days since the last message', () => {
    expect(daysSinceIso('2026-09-16T09:00:00Z', now)).toBe(0)
    expect(daysSinceIso('2026-09-15T09:00:00Z', now)).toBe(1)
    expect(daysSinceIso('2026-09-09T09:00:00Z', now)).toBe(7)
  })
  it('never goes negative when a stamp is slightly ahead of the clock', () => {
    expect(daysSinceIso('2026-09-16T19:00:00Z', now)).toBe(0)
  })
  it('is null for nothing sent yet, or an unparseable stamp', () => {
    expect(daysSinceIso(null, now)).toBeNull()
    expect(daysSinceIso(undefined, now)).toBeNull()
    expect(daysSinceIso('not a date', now)).toBeNull()
  })
})
