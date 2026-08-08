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
