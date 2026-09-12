import { describe, it, expect } from 'vitest'
import {
  buildSfJobIndex, matchToSfJob, splitPos, nameKey, normPhone,
  type SfJobLite, type SfCustomerContact,
} from '@/lib/matching/sf-job-match'

const job = (id: string, number: string, opts: Partial<SfJobLite> = {}): SfJobLite =>
  ({ id, number, customer_name: null, customer_id: null, po_number: null, ...opts })

describe('normalizers', () => {
  it('splits multi-PO fields on ; / ,', () => {
    expect(splitPos('73437205 / 99887')).toEqual(['73437205', '99887'])
    expect(splitPos('A; B , C')).toEqual(['A', 'B', 'C'])
    expect(splitPos(null)).toEqual([])
  })
  it('name key is order- and comma-insensitive', () => {
    expect(nameKey('SERRANO, GLORIA')).toBe(nameKey('Gloria Serrano'))
    expect(nameKey('Messerschmidt, Kathy')).toBe('KATHY MESSERSCHMIDT')
  })
  it('phone keeps the last 10 digits', () => {
    expect(normPhone('(619) 592-0362')).toBe('6195920362')
    expect(normPhone('1-619-592-0362')).toBe('6195920362')
  })
})

describe('matchToSfJob', () => {
  it('matches a PO that is one of several on a job (membership, not equality)', () => {
    const idx = buildSfJobIndex([job('j1', '1001', { po_number: '73437205 / 99887' })])
    expect(matchToSfJob(idx, { po: '99887' })).toMatchObject({ sfJobNumber: '1001', method: 'po' })
    expect(matchToSfJob(idx, { po: '73437205' })).toMatchObject({ sfJobNumber: '1001', method: 'po' })
    expect(matchToSfJob(idx, { po: 'nope' }).sfJobNumber).toBeNull()
  })

  it('falls back to customer name (order/comma-insensitive) when PO misses', () => {
    const idx = buildSfJobIndex([job('j1', '1001', { customer_name: 'Serrano, Gloria' })])
    expect(matchToSfJob(idx, { po: 'x', customerName: 'GLORIA SERRANO' })).toMatchObject({ sfJobNumber: '1001', method: 'name' })
  })

  it('does not guess when a name maps to multiple jobs (ambiguous)', () => {
    const idx = buildSfJobIndex([
      job('j1', '1001', { customer_name: 'John Smith' }),
      job('j2', '1002', { customer_name: 'Smith, John' }),
    ])
    const m = matchToSfJob(idx, { customerName: 'John Smith' })
    expect(m.sfJobNumber).toBeNull()
    expect(m.ambiguous).toBe(true)
  })

  it('falls back to email, then phone, via the customer', () => {
    const jobs = [job('j1', '1001', { customer_id: 'c1' })]
    const custs: SfCustomerContact[] = [{ id: 'c1', email: 'Kathie@YAHOO.com', phone: '(858) 252-9993' }]
    const idx = buildSfJobIndex(jobs, custs)
    expect(matchToSfJob(idx, { email: 'kathie@yahoo.com' })).toMatchObject({ sfJobNumber: '1001', method: 'email' })
    expect(matchToSfJob(idx, { phone: '858-252-9993' })).toMatchObject({ sfJobNumber: '1001', method: 'phone' })
  })

  it('is ambiguous (no guess) when a customer has multiple jobs', () => {
    const jobs = [job('j1', '1001', { customer_id: 'c1' }), job('j2', '1002', { customer_id: 'c1' })]
    const custs: SfCustomerContact[] = [{ id: 'c1', email: 'a@b.com', phone: null }]
    const idx = buildSfJobIndex(jobs, custs)
    const m = matchToSfJob(idx, { email: 'a@b.com' })
    expect(m.sfJobNumber).toBeNull()
    expect(m.ambiguous).toBe(true)
  })

  it('honors priority: PO beats name, linked beats PO', () => {
    const idx = buildSfJobIndex([
      job('j1', '1001', { po_number: '555', customer_name: 'Shared Name' }),
      job('j2', '1002', { customer_name: 'Shared Name' }),
      job('j3', '1003'),
    ])
    // PO points at j1 even though the name is shared/ambiguous.
    expect(matchToSfJob(idx, { po: '555', customerName: 'Shared Name' })).toMatchObject({ sfJobNumber: '1001', method: 'po' })
    // linkedJobId wins over everything.
    expect(matchToSfJob(idx, { po: '555', linkedJobId: 'j3' })).toMatchObject({ sfJobNumber: '1003', method: 'linked' })
  })
})

// "Unmatch" on HD Orders records the rejected job on the order. The matcher must then skip
// it at every strength — otherwise the same wrong job comes straight back on the next load.
describe('matchToSfJob with excluded (unmatched) jobs', () => {
  const jobA = { id: 'A', number: '1000', customer_name: 'Gloria Serrano', customer_id: 'c1', po_number: 'PO-1' }
  const jobB = { id: 'B', number: '2000', customer_name: 'Gloria Serrano', customer_id: 'c2', po_number: null }
  it('skips an excluded job even on a PO hit, falling through to the next method', () => {
    const index = buildSfJobIndex([jobA, jobB], [])
    expect(matchToSfJob(index, { po: 'PO-1', customerName: 'Serrano, Gloria' })).toMatchObject({ sfJobId: 'A', method: 'po' })
    // A excluded: PO no longer resolves; name would now be ambiguous (A and B) except A is gone.
    expect(matchToSfJob(index, { po: 'PO-1', customerName: 'Serrano, Gloria', excludedJobIds: ['A'] })).toMatchObject({ sfJobId: 'B', method: 'name' })
  })
  it('returns no match when every candidate is excluded', () => {
    const index = buildSfJobIndex([jobA], [{ id: 'c1', email: 'g@x.com', phone: '6195551234' }])
    const r = matchToSfJob(index, { po: 'PO-1', customerName: 'Gloria Serrano', email: 'g@x.com', phone: '(619) 555-1234', excludedJobIds: ['A'] })
    expect(r).toMatchObject({ sfJobId: null, sfJobNumber: null, method: null, ambiguous: false })
  })
})

// A returning customer's old job shares the name, email and phone with the new order but is
// not the new order. Name/email/phone only consider jobs created in the last 90 days; a PO
// hit or a stored link is exact and ignores age.
describe('matchToSfJob age gate on weak matches', () => {
  const now = new Date('2026-09-12T12:00:00Z')
  const old = { id: 'old', number: '1000', customer_name: 'Gloria Serrano', customer_id: 'c1', po_number: 'PO-OLD', created_at_sf: '2026-03-01T00:00:00Z' }
  const fresh = { id: 'new', number: '2000', customer_name: 'Gloria Serrano', customer_id: 'c1', po_number: null, created_at_sf: '2026-09-01T00:00:00Z' }
  it('does not name-match a job created over 90 days ago', () => {
    const index = buildSfJobIndex([old], [{ id: 'c1', email: 'g@x.com', phone: '6195551234' }])
    const r = matchToSfJob(index, { customerName: 'Serrano, Gloria', email: 'g@x.com', phone: '6195551234' }, { now })
    expect(r).toMatchObject({ sfJobId: null, method: null, ambiguous: false })
  })
  it('an old job does not make the customer\'s new job ambiguous', () => {
    const index = buildSfJobIndex([old, fresh], [{ id: 'c1', email: 'g@x.com', phone: '6195551234' }])
    expect(matchToSfJob(index, { customerName: 'Gloria Serrano' }, { now })).toMatchObject({ sfJobId: 'new', method: 'name' })
    expect(matchToSfJob(index, { email: 'g@x.com' }, { now })).toMatchObject({ sfJobId: 'new', method: 'email' })
  })
  it('a PO hit or a stored link still matches an old job', () => {
    const index = buildSfJobIndex([old], [])
    expect(matchToSfJob(index, { po: 'PO-OLD' }, { now })).toMatchObject({ sfJobId: 'old', method: 'po' })
    expect(matchToSfJob(index, { linkedJobId: 'old' }, { now })).toMatchObject({ sfJobId: 'old', method: 'linked' })
  })
})
