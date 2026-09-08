import { describe, it, expect } from 'vitest'
import { sfPhone, sfPhones } from '@/lib/crm/phone'

// Service Fusion rejects a customer create outright when a phone is not exactly ten
// digits. Every form we store a phone in has to come out of here as ten digits or nothing.
describe('sfPhone', () => {
  it('strips the E.164 country code the lead/SMS pipeline stores', () => {
    expect(sfPhone('+16195551234')).toBe('6195551234')
  })
  it('strips web-form punctuation', () => {
    expect(sfPhone('(619) 555-1234')).toBe('6195551234')
    expect(sfPhone('619.555.1234')).toBe('6195551234')
    expect(sfPhone('619 555 1234')).toBe('6195551234')
  })
  it('accepts a bare eleven digits with a leading 1', () => {
    expect(sfPhone('16195551234')).toBe('6195551234')
  })
  it('passes ten digits through untouched', () => {
    expect(sfPhone('6195551234')).toBe('6195551234')
  })
  it('returns null for anything that cannot be made to fit, rather than something SF will reject', () => {
    expect(sfPhone('555-1234')).toBeNull()            // seven digits
    expect(sfPhone('+442071234567')).toBeNull()       // not a US number
    expect(sfPhone('26195551234')).toBeNull()         // eleven digits, wrong prefix
    expect(sfPhone('')).toBeNull()
    expect(sfPhone(null)).toBeNull()
    expect(sfPhone(undefined)).toBeNull()
  })
})

describe('sfPhones', () => {
  it('builds the contact fragment', () => {
    expect(sfPhones('+16195551234')).toEqual({ phones: [{ phone: '6195551234', type: 'Mobile' }] })
    expect(sfPhones('6195551234', 'Home')).toEqual({ phones: [{ phone: '6195551234', type: 'Home' }] })
  })
  it('contributes nothing when there is no usable phone — so the rest of the customer still saves', () => {
    expect(sfPhones('555-1234')).toEqual({})
    expect(sfPhones(null)).toEqual({})
  })
})
