/**
 * Lead → SF customer name splitting (used when pre-creating the SF customer).
 */
import { describe, it, expect } from 'vitest'
import { splitName, type LeadForCustomer } from '@/lib/leadgen/sf-customer'

function lead(partial: Partial<LeadForCustomer>): LeadForCustomer {
  return {
    id: 'x', customer_name: null, greeting_name: null, phone_e164: null, phone_raw: null,
    email: null, address_street: null, address_city: null, address_state: null, address_postal: null,
    ...partial,
  }
}

describe('splitName', () => {
  it('splits a normal "First Last"', () => {
    expect(splitName(lead({ customer_name: 'Darryl Jones' }))).toEqual({ first: 'Darryl', last: 'Jones' })
  })
  it('keeps multi-word last names', () => {
    expect(splitName(lead({ customer_name: 'Maria Del Rio' }))).toEqual({ first: 'Maria', last: 'Del Rio' })
  })
  it('prefers the parsed greeting name for first', () => {
    expect(splitName(lead({ customer_name: 'Robert Shands', greeting_name: 'Rob' }))).toEqual({ first: 'Rob', last: 'Shands' })
  })
  it('defaults last name to "." for a single-token name (SF requires a last name)', () => {
    expect(splitName(lead({ customer_name: 'Cher' }))).toEqual({ first: 'Cher', last: '.' })
  })
  it('falls back to "Customer" when there is no name at all', () => {
    expect(splitName(lead({}))).toEqual({ first: 'Customer', last: '.' })
  })
})
