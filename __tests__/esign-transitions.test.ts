import { describe, it, expect } from 'vitest'
import { scopeForToken, signState, statusAfterSign, decodeDataUrlPng, isPng } from '@/lib/esign/transitions'

const doc = { status: 'sent_customer', customer_token: 'cust_tok_1234567890', tech_token: 'tech_tok_1234567890', customer_signed_at: null, tech_signed_at: null }
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='

describe('signing state machine', () => {
  it('knows whose token it is', () => {
    expect(scopeForToken(doc, doc.customer_token)).toBe('customer')
    expect(scopeForToken(doc, doc.tech_token)).toBe('tech')
    expect(scopeForToken(doc, 'nope')).toBeNull()
    expect(scopeForToken(doc, '')).toBeNull()
  })
  it('customer may sign while prepared/sent, once; never after cancel', () => {
    expect(signState({ ...doc, status: 'prepared' }, 'customer')).toBe('ready')
    expect(signState(doc, 'customer')).toBe('ready')
    expect(signState({ ...doc, status: 'customer_signed', customer_signed_at: 'x' }, 'customer')).toBe('already_signed')
    expect(signState({ ...doc, status: 'unrecognised_template' }, 'customer')).toBe('not_ready')
    expect(signState({ ...doc, status: 'cancelled' }, 'customer')).toBe('cancelled')
  })
  it('tech waits for the customer, then signs once', () => {
    expect(signState(doc, 'tech')).toBe('waiting_customer')
    expect(signState({ ...doc, status: 'found' }, 'tech')).toBe('waiting_customer')
    expect(signState({ ...doc, status: 'customer_signed', customer_signed_at: 'x' }, 'tech')).toBe('ready')
    expect(signState({ ...doc, status: 'sent_tech', customer_signed_at: 'x' }, 'tech')).toBe('ready')
    expect(signState({ ...doc, status: 'tech_signed', customer_signed_at: 'x', tech_signed_at: 'y' }, 'tech')).toBe('already_signed')
    expect(signState({ ...doc, status: 'completed', customer_signed_at: 'x', tech_signed_at: 'y' }, 'tech')).toBe('already_signed')
  })
  it('moves status only from the states it may sign in', () => {
    expect(statusAfterSign('customer', 'sent_customer')).toBe('customer_signed')
    expect(statusAfterSign('customer', 'customer_signed')).toBeNull()
    expect(statusAfterSign('tech', 'customer_signed')).toBe('tech_signed')
    expect(statusAfterSign('tech', 'prepared')).toBeNull()
  })
  it('accepts only a real PNG data URL within the size cap', () => {
    const bytes = decodeDataUrlPng(`data:image/png;base64,${PNG_B64}`)
    expect(bytes && isPng(bytes)).toBe(true)
    expect(decodeDataUrlPng(`data:image/jpeg;base64,${PNG_B64}`)).toBeNull()
    expect(decodeDataUrlPng('data:image/png;base64,AAAA')).toBeNull()
    expect(decodeDataUrlPng(`data:image/png;base64,${'A'.repeat(1_500_000)}`)).toBeNull()
  })
})
