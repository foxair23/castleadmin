import { describe, it, expect } from 'vitest'
import { parseDcReport, toIsoDate } from '@/lib/clopay-dc/report-parse'
import { poKeyFor } from '@/lib/clopay-dc/ingest'

// Shaped after the real 31-Aug-2026 report: an HD block (Clopay customer 000032) and a
// Castle-direct block (customer 61232, which reaches no other system we have). Real PO forms
// are included — plain digits plus the RP/RPP variants that a \d+ pattern would drop.
const REPORT = [
  'CLOPAY BUILDING PRODUCTS',
  'DC ORDERS FULLY RECEIVED AND RESERVED',
  'RUN DATE: 31-AUG-2026',
  '',
  'CUSTOMER: 000032  HOME DEPOT INC',
  'ORDER NO    PO NUMBER      ENTERED       RESERVED',
  '181190873   12503443       20-JAN-2026   22-JAN-2026',
  '181190922   RPP88431947    22-JAN-2026   10-FEB-2026',
  '181193623   RP48478131     03-JUN-2026   24-JUN-2026',
  '181194156   74491410       30-JUN-2026   15-JUL-2026',
  '',
  'CUSTOMER: 61232  CASTLE GARAGE INC',
  'ORDER NO    PO NUMBER      ENTERED       RESERVED',
  '181193973                  22-JUN-2026   22-JUN-2026',
  '181195025                  11-AUG-2026   11-AUG-2026',
].join('\n')

describe('parseDcReport', () => {
  const r = parseDcReport(REPORT)

  it('reads every data row and ignores the headers', () => {
    expect(r.rows).toHaveLength(6)
    expect(r.ok).toBe(true)
  })

  it('picks up the report run date', () => {
    expect(r.reportDate).toBe('2026-08-31')
  })

  it('keeps non-numeric PO forms intact', () => {
    expect(r.rows.find(x => x.orderNo === '181190922')?.po).toBe('RPP88431947')
    expect(r.rows.find(x => x.orderNo === '181193623')?.po).toBe('RP48478131')
  })

  it('separates Castle-direct orders, which carry no PO', () => {
    const castle = r.rows.filter(x => x.kind === 'CASTLE_DIRECT')
    expect(castle.map(c => c.orderNo)).toEqual(['181193973', '181195025'])
    expect(castle.every(c => c.po === null)).toBe(true)
    expect(r.rows.filter(x => x.kind === 'HD')).toHaveLength(4)
  })

  it('reads both dates, entered before reserved', () => {
    const row = r.rows.find(x => x.orderNo === '181190873')!
    expect(row.enteredDate).toBe('2026-01-20')
    expect(row.reservedDate).toBe('2026-01-22')
  })

  it('does not mistake a date for a PO', () => {
    // A Castle-direct row's PO is legitimately null; the trap is a date sliding into the
    // column when the PO is absent.
    for (const row of r.rows) {
      if (row.po !== null) expect(row.po).not.toMatch(/\d{1,2}-[A-Z]{3}-\d{4}/)
    }
  })

  it('returns nothing (not garbage) for text that is not a DC report', () => {
    const empty = parseDcReport('Some other Clopay attachment\nwith no order table.')
    expect(empty.rows).toEqual([])
    expect(empty.ok).toBe(false)
  })
})

describe('toIsoDate', () => {
  it('converts the report format', () => {
    expect(toIsoDate('22-JAN-2026')).toBe('2026-01-22')
    expect(toIsoDate('5-SEP-2026')).toBe('2026-09-05')
  })
  it('rejects anything else', () => {
    expect(toIsoDate('2026-01-22')).toBeNull()
    expect(toIsoDate(null)).toBeNull()
  })
})

describe('poKeyFor', () => {
  // The worklist unit is the PO: one customer can have one PO at the DC while another has
  // not arrived, so they must dismiss independently.
  it('keys on the PO when there is one', () => {
    expect(poKeyFor({ po: '68443644', orderNo: '181194840' })).toBe('PO:68443644')
    expect(poKeyFor({ po: '68443645', orderNo: '181194841' }))
      .not.toBe(poKeyFor({ po: '68443644', orderNo: '181194840' }))
  })
  it('falls back to the order number for Castle-direct rows', () => {
    expect(poKeyFor({ po: null, orderNo: '181193973' })).toBe('ORDER:181193973')
  })
  it('is stable across reports — the same PO keys the same every week', () => {
    expect(poKeyFor({ po: '74491410', orderNo: '181194156' }))
      .toBe(poKeyFor({ po: '74491410', orderNo: '181194156' }))
  })
})
