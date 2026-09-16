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
