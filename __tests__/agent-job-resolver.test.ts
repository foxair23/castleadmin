import { describe, it, expect } from 'vitest'
import {
  resolveFromCandidates, isInScope, normPo, jobPoTokens,
  type CandidateJob, type VendorLink, type CustomerContacts,
} from '@/lib/agent/job-resolver'

const NOW = Date.parse('2026-09-07T12:00:00Z')
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString()

const job = (id: string, o: Partial<CandidateJob> = {}): CandidateJob => ({
  id, number: `J${id}`, customer_id: null, customer_name: null, po_number: null,
  status: 'Scheduled', start_date: daysAgo(-3), closed_at: null, ...o,
})

describe('normalisers', () => {
  it('normPo strips a PO prefix and punctuation', () => {
    expect(normPo('PO# 1020259181')).toBe('1020259181')
    expect(normPo('po 73437205')).toBe('73437205')
    expect(normPo(' 1020259181 ')).toBe('1020259181')
  })
  it('jobPoTokens splits multi-PO fields', () => {
    expect(jobPoTokens('1020259181, 1020259182 / 1020259183')).toEqual(['1020259181', '1020259182', '1020259183'])
    expect(jobPoTokens(null)).toEqual([])
  })
})

describe('scope window', () => {
  it('active jobs are always in scope', () => {
    expect(isInScope(job('1', { status: 'Waiting on Parts' }), NOW)).toBe(true)
    expect(isInScope(job('1', { status: 'Scheduled', start_date: daysAgo(400) }), NOW)).toBe(true)
  })
  it('cancelled / void / deleted never are', () => {
    expect(isInScope(job('1', { status: 'Cancelled' }), NOW)).toBe(false)
    expect(isInScope(job('1', { status: 'Void' }), NOW)).toBe(false)
    expect(isInScope(job('1', { is_deleted: true }), NOW)).toBe(false)
  })
  it('completed jobs stay in scope for 60 days, by the most trusted finish date', () => {
    expect(isInScope(job('1', { status: 'Completed', closed_at: daysAgo(59) }), NOW)).toBe(true)
    expect(isInScope(job('1', { status: 'Completed', closed_at: daysAgo(61) }), NOW)).toBe(false)
    expect(isInScope(job('1', { status: 'Invoiced', closed_at: daysAgo(10), work_completed_at: daysAgo(90) }), NOW)).toBe(false)
    expect(isInScope(job('1', { status: 'Paid', closed_at: null, start_date: daysAgo(20) }), NOW)).toBe(true)
    expect(isInScope(job('1', { status: 'Completed', closed_at: null, start_date: null }), NOW)).toBe(false)
  })
  it('window is configurable', () => {
    expect(isInScope(job('1', { status: 'Completed', closed_at: daysAgo(80) }), NOW, 90)).toBe(true)
  })
})

describe('PO tier', () => {
  const jobs = [
    job('a', { po_number: '1020259181, 1020259182' }),
    job('b', { po_number: '73437205' }),
    job('old', { po_number: '55555', status: 'Completed', closed_at: daysAgo(200) }),
  ]
  it('matches by PO membership in a multi-PO field', () => {
    const r = resolveFromCandidates({ identifiers: { pos: ['PO# 1020259182'] }, jobs, now: NOW })
    expect(r.status).toBe('matched')
    if (r.status === 'matched') { expect(r.job.id).toBe('a'); expect(r.tier).toBe('po'); expect(r.matchedPo).toBe('1020259182'); expect(r.viaVendorOrder).toBe(false) }
  })
  it('a PO on two live jobs is ambiguous, never a pick', () => {
    const dup = [...jobs, job('c', { po_number: '73437205' })]
    const r = resolveFromCandidates({ identifiers: { pos: ['73437205'] }, jobs: dup, now: NOW })
    expect(r.status).toBe('ambiguous')
    if (r.status === 'ambiguous') expect(r.candidates.map(j => j.id).sort()).toEqual(['b', 'c'])
  })
  it('resolves through a vendor order when the SF job never got the PO typed on it', () => {
    const vendorLinks: VendorLink[] = [{ vendor: 'clopay_hd', pos: ['1020259999'], sf_job_id: 'b' }]
    const r = resolveFromCandidates({ identifiers: { pos: ['1020259999'] }, jobs, vendorLinks, now: NOW })
    expect(r.status).toBe('matched')
    if (r.status === 'matched') { expect(r.job.id).toBe('b'); expect(r.viaVendorOrder).toBe(true) }
  })
  it('same job via both paths is one match, not ambiguous', () => {
    const vendorLinks: VendorLink[] = [{ vendor: 'clopay_hd', pos: ['73437205'], sf_job_id: 'b' }]
    const r = resolveFromCandidates({ identifiers: { pos: ['73437205'] }, jobs, vendorLinks, now: NOW })
    expect(r.status).toBe('matched')
  })
  it('a PO that only hits a long-closed job is none, with the old job reported', () => {
    const r = resolveFromCandidates({ identifiers: { pos: ['55555'] }, jobs, now: NOW })
    expect(r.status).toBe('none')
    if (r.status === 'none') { expect(r.tried).toEqual(['po']); expect(r.outOfScope.map(j => j.id)).toEqual(['old']) }
  })
  it('PO wins over a name that would be ambiguous', () => {
    const two = [job('x', { po_number: '111', customer_name: 'SMITH, JOHN' }), job('y', { customer_name: 'John Smith' })]
    const r = resolveFromCandidates({ identifiers: { pos: ['111'], customerName: 'John Smith' }, jobs: two, now: NOW })
    expect(r.status).toBe('matched')
    if (r.status === 'matched') expect(r.job.id).toBe('x')
  })
})

describe('name tier', () => {
  it('matches "Last, First" against "First Last"', () => {
    const jobs = [job('a', { customer_name: 'SERRANO, GLORIA' }), job('b', { customer_name: 'COOREY, MARK' })]
    const r = resolveFromCandidates({ identifiers: { customerName: 'Gloria Serrano' }, jobs, now: NOW })
    expect(r.status).toBe('matched')
    if (r.status === 'matched') { expect(r.job.id).toBe('a'); expect(r.tier).toBe('name') }
  })
  it('folds nicknames when there is no exact key match', () => {
    const jobs = [job('a', { customer_name: 'MESSERSCHMIDT, CATHERINE' })]
    const r = resolveFromCandidates({ identifiers: { customerName: 'Kathy Messerschmidt' }, jobs, now: NOW })
    expect(r.status).toBe('matched')
  })
  it('falls back to contact first/last when customer_name is empty', () => {
    const jobs = [job('a', { customer_name: null, contact_first_name: 'Tina', contact_last_name: 'Chang' })]
    expect(resolveFromCandidates({ identifiers: { customerName: 'Chang, Tina' }, jobs, now: NOW }).status).toBe('matched')
  })
  it('two live jobs for the same customer name → ambiguous with both listed', () => {
    const jobs = [job('a', { customer_name: 'SMITH, JOHN' }), job('b', { customer_name: 'John Smith' })]
    const r = resolveFromCandidates({ identifiers: { customerName: 'john smith' }, jobs, now: NOW })
    expect(r.status).toBe('ambiguous')
    if (r.status === 'ambiguous') expect(r.candidates).toHaveLength(2)
  })
  it('an old closed duplicate does not make a live match ambiguous', () => {
    const jobs = [job('a', { customer_name: 'SMITH, JOHN' }), job('b', { customer_name: 'John Smith', status: 'Completed', closed_at: daysAgo(300) })]
    const r = resolveFromCandidates({ identifiers: { customerName: 'john smith' }, jobs, now: NOW })
    expect(r.status).toBe('matched')
    if (r.status === 'matched') expect(r.job.id).toBe('a')
  })
  it('a partial name (surname only) does not match', () => {
    const jobs = [job('a', { customer_name: 'SERRANO, GLORIA' })]
    expect(resolveFromCandidates({ identifiers: { customerName: 'Serrano' }, jobs, now: NOW }).status).toBe('none')
  })
})

describe('email / phone tiers', () => {
  const contacts: CustomerContacts = {
    emailToCustomer: new Map([['tina@example.com', 'C1']]),
    phoneToCustomer: new Map([['6195551234', 'C2']]),
  }
  it('email → customer → single live job', () => {
    const jobs = [job('a', { customer_id: 'C1' })]
    const r = resolveFromCandidates({ identifiers: { email: 'Tina@Example.com' }, jobs, contacts, now: NOW })
    expect(r.status).toBe('matched')
    if (r.status === 'matched') expect(r.tier).toBe('email')
  })
  it('phone with formatting and country code', () => {
    const jobs = [job('a', { customer_id: 'C2' })]
    const r = resolveFromCandidates({ identifiers: { phone: '+1 (619) 555-1234' }, jobs, contacts, now: NOW })
    expect(r.status).toBe('matched')
    if (r.status === 'matched') expect(r.tier).toBe('phone')
  })
  it('a customer with two live jobs is ambiguous', () => {
    const jobs = [job('a', { customer_id: 'C1' }), job('b', { customer_id: 'C1' })]
    expect(resolveFromCandidates({ identifiers: { email: 'tina@example.com' }, jobs, contacts, now: NOW }).status).toBe('ambiguous')
  })
  it('nothing supplied → none with nothing tried', () => {
    const r = resolveFromCandidates({ identifiers: {}, jobs: [], now: NOW })
    expect(r).toEqual({ status: 'none', tried: [], outOfScope: [] })
  })
})
