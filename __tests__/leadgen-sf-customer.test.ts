/**
 * Lead → SF customer name splitting (used when pre-creating the SF customer).
 */
import { describe, it, expect, vi } from 'vitest'
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

// The leadgen-match cron was failing every run with SF's 422:
//   "Contacts[0]: Phones[0]: Phone must contains 10 digits"
// because leads carry phone_e164 ("+1…"). This pins the payload SF actually receives.
vi.mock('@/lib/crm/service-fusion', () => ({ sfPost: vi.fn(async () => ({ id: 4242 })) }))
vi.mock('@/lib/scheduler/sf-customer-match', () => ({
  findExistingSfCustomer: vi.fn(async () => null),
  updateExistingCustomerContactInfo: vi.fn(async () => {}),
}))
vi.mock('@/lib/leadgen/engine', () => ({ loadLeadGenSettings: vi.fn(async () => ({ enabled: true })) }))

import { ensureLeadCustomer } from '@/lib/leadgen/sf-customer'
import { sfPost } from '@/lib/crm/service-fusion'

function fakeDb() {
  const updates: Array<Record<string, unknown>> = []
  const db = { from: () => ({ update: (row: Record<string, unknown>) => ({ eq: async () => { updates.push(row); return { error: null } } }) }) }
  return { db: db as never, updates }
}

describe('ensureLeadCustomer → SF payload', () => {
  it('sends the ten-digit phone SF accepts, not the E.164 we store', async () => {
    vi.mocked(sfPost).mockClear()
    const { db, updates } = fakeDb()
    const r = await ensureLeadCustomer(db, lead({ customer_name: 'Darryl Jones', phone_e164: '+16195551234', email: 'd@x.com' }))
    expect(r).toBe('created')
    const payload = vi.mocked(sfPost).mock.calls[0][1] as { contacts: Array<{ phones?: Array<{ phone: string }> }> }
    expect(payload.contacts[0].phones).toEqual([{ phone: '6195551234', type: 'Mobile' }])
    expect(updates[0]).toMatchObject({ sf_customer_id: '4242', sf_customer_source: 'created' })
  })

  it('leaves the phone off rather than sink the whole customer when it cannot be made to fit', async () => {
    vi.mocked(sfPost).mockClear()
    const { db } = fakeDb()
    const r = await ensureLeadCustomer(db, lead({ customer_name: 'Cher', phone_raw: '555-1234', email: 'c@x.com' }))
    expect(r).toBe('created')
    const payload = vi.mocked(sfPost).mock.calls[0][1] as { contacts: Array<{ phones?: unknown; emails?: unknown }> }
    expect(payload.contacts[0].phones).toBeUndefined()
    expect(payload.contacts[0].emails).toEqual([{ email: 'c@x.com' }])
  })
})
