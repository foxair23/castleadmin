import { describe, it, expect } from 'vitest'
import { toSfServices, type IpoLineRow } from '@/lib/vendor-orders/ipo-services'

const line = (o: Partial<IpoLineRow>): IpoLineRow => ({
  order_id: 'o1', item_number: 'FIR010', description: 'Install of door up to 10 ft',
  quantity: 1, line_fee: 338, unit_fee: 338, ...o,
})

describe('toSfServices', () => {
  it('maps a line onto the SF service body shape', () => {
    const [s] = toSfServices([line({})])
    expect(s.service).toBe('FIR010')       // the catalog service — the only required field
    expect(s.multiplier).toBe(1)
    expect(s.rate).toBe(338)
  })

  it('sends the UNIT rate, not the line total', () => {
    // The IPO prints a line total. Sending that as `rate` would multiply the money by the
    // quantity — a $600 line at quantity 4 would bill SF $2,400.
    const [s] = toSfServices([line({ item_number: 'FIR930', quantity: 4, line_fee: 600, unit_fee: 150 })])
    expect(s.rate).toBe(150)
    expect(s.multiplier).toBe(4)
  })

  it('derives the unit rate when unit_fee is missing', () => {
    const [s] = toSfServices([line({ quantity: 4, line_fee: 600, unit_fee: null })])
    expect(s.rate).toBe(150)
  })

  it('skips lines with no revenue', () => {
    // Doors, openers and parts ship at $0.00 and are Clopay product codes that may not exist
    // as SF services — an unknown `service` is a 422 that costs the whole array.
    const out = toSfServices([
      line({ item_number: 'DC13', line_fee: 0, unit_fee: 0 }),
      line({ item_number: '0650792', line_fee: 0, unit_fee: 0 }),
      line({}),
    ])
    expect(out.map(s => s.service)).toEqual(['FIR010'])
  })

  it('sends a revenue line that has no agreed rate', () => {
    // FIR1010 carries revenue but is absent from the labor schedule. What we SEND and what we
    // FLAG are different questions.
    const [s] = toSfServices([line({ item_number: 'FIR1010', line_fee: 20, unit_fee: 20 })])
    expect(s.service).toBe('FIR1010')
  })

  it('skips a line with no item number', () => {
    expect(toSfServices([line({ item_number: null })])).toEqual([])
    expect(toSfServices([line({ item_number: '   ' })])).toEqual([])
  })

  it('rounds quantity to an integer and never below one', () => {
    expect(toSfServices([line({ quantity: 2.4 })])[0].multiplier).toBe(2)
    expect(toSfServices([line({ quantity: 0 })])[0].multiplier).toBe(1)
    expect(toSfServices([line({ quantity: null })])[0].multiplier).toBe(1)
  })

  it('labels each line with its door on a multi-door job', () => {
    // The same code appears once per door; without the PO the office cannot tell which line
    // belongs to which door.
    const pos = new Map([['o1', '68443644'], ['o2', '68443645']])
    const out = toSfServices([line({ order_id: 'o1' }), line({ order_id: 'o2' })], pos)
    expect(out[0].description).toBe('PO 68443644 — Install of door up to 10 ft')
    expect(out[1].description).toBe('PO 68443645 — Install of door up to 10 ft')
  })

  it('leaves the description alone on a single-door job', () => {
    const out = toSfServices([line({})], new Map([['o1', '68443644']]))
    expect(out[0].description).toBe('Install of door up to 10 ft')
  })
})
