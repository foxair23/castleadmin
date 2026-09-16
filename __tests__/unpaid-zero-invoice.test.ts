import { describe, it, expect } from 'vitest'

// The rule the Unpaid tab uses to decide a job has been settled on the invoice side, stated
// on its own. A payment in Service Fusion updates the INVOICE, never the job, so the job's
// due_total stays frozen forever and this is the only thing that can clear it.
//
// Job 1020258096 is why the zero check exists: a real $473 receivable, closed 11 Jul, with
// one invoice for $0.00 marked paid. Money owed cannot be settled by an invoice for nothing.
type Inv = { is_paid: boolean | null; total: number | string | null }
const settled = (invoices: Inv[]) => {
  const real = invoices.filter(i => Number(i.total ?? 0) > 0)
  return real.length > 0 && real.every(i => i.is_paid)
}

describe('is a job settled on the invoice side', () => {
  it('a $0 invoice marked paid settles nothing — the 1020258096 case', () => {
    expect(settled([{ is_paid: true, total: 0 }])).toBe(false)
    expect(settled([{ is_paid: true, total: '0.00' }])).toBe(false)
  })
  it('a real invoice, paid, does settle it', () => {
    expect(settled([{ is_paid: true, total: 473 }])).toBe(true)
    expect(settled([{ is_paid: true, total: '473.00' }])).toBe(true)
  })
  it('one unpaid real invoice keeps the job owing, whatever else is paid', () => {
    expect(settled([{ is_paid: true, total: 100 }, { is_paid: false, total: 373 }])).toBe(false)
  })
  it('a paid real invoice alongside a $0 one still settles it', () => {
    expect(settled([{ is_paid: true, total: 0 }, { is_paid: true, total: 473 }])).toBe(true)
  })
  it('no invoices at all is not settlement — that is a job never invoiced', () => {
    expect(settled([])).toBe(false)
    expect(settled([{ is_paid: true, total: null }])).toBe(false)
  })
})
