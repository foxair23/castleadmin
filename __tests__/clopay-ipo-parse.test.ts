import { describe, it, expect } from 'vitest'
import { parseIpoText, parseIpoDocument, sectionForOrder, isIpoDoc } from '../lib/vendor-orders/clopay-ipo'
import { SIMPLE_TWO_LINE, WRAPPED_ITEM_NUMBER, OPENER_AND_DOOR, MULTI_FEE } from './fixtures/clopay-ipo-samples'
import unpdfTexts from './fixtures/unpdf-texts.json'
import multipage from './fixtures/clopay-ipo-multipage.json'

// The document's own "TOTAL :" is the checksum: if the parser drops, merges, or
// misreads a line, sum(line fees) stops matching and `ok` goes false.
const ALL = [
  { name: 'simple two-line', text: SIMPLE_TWO_LINE, order: '181194873', items: 2, total: 100 },
  { name: 'wrapped item number', text: WRAPPED_ITEM_NUMBER, order: '181193343', items: 4, total: 600 },
  { name: 'opener + door', text: OPENER_AND_DOOR, order: '181194831', items: 7, total: 478 },
  { name: 'multi fee', text: MULTI_FEE, order: '181195368', items: 6, total: 532 },
]

describe('parseIpoText', () => {
  for (const c of ALL) {
    it(`parses the ${c.name} IPO and balances against its stated total`, () => {
      const r = parseIpoText(c.text)
      expect(r.items).toHaveLength(c.items)
      expect(r.totalFee).toBeCloseTo(c.total, 2)
      expect(r.orderNumber).toBe(c.order)
      expect(r.ok).toBe(true)
      const sum = r.items.reduce((a, i) => a + i.line_fee, 0)
      expect(sum).toBeCloseTo(c.total, 2)
      // Every line must carry the fields Phase 2 needs to build SF line items.
      for (const i of r.items) {
        expect(i.item_number).toMatch(/\S/)
        expect(i.quantity).toBeGreaterThan(0)
        expect(Number.isFinite(i.line_fee)).toBe(true)
        expect(i.line_no).toMatch(/^\d+\.\d+$/)
      }
    })
  }

  it('reads header metadata', () => {
    const r = parseIpoText(SIMPLE_TWO_LINE)
    expect(r.poNumber).toBe('48510316')
    expect(r.orderDate).toBe('2026-08-03')
  })

  it('keeps a multi-line description together and puts the fee on the right line', () => {
    const r = parseIpoText(SIMPLE_TWO_LINE)
    const door = r.items[0]
    expect(door.item_number).toBe('DC13')
    expect(door.line_fee).toBe(0)
    expect(door.description).toContain('CLOPAY POLYSTYRENE')
    expect(door.description).toContain('WIDTH X HEIGHT : 15ft X 7ft') // wrapped line joined
    const delivery = r.items[1]
    expect(delivery.item_number).toBe('FIR670')
    expect(delivery.line_fee).toBe(100)
    expect(delivery.description).toBe('DOUBLE CAR DOOR DELIVERY CHARGE')
  })

  it('reassembles an item number split across lines', () => {
    const r = parseIpoText(WRAPPED_ITEM_NUMBER)
    expect(r.items[0].item_number).toBe('CAN212-CD*R498920')
    expect(r.items[0].quantity).toBe(4)
    expect(r.items[3].item_number).toBe('FIR930')
    expect(r.items[3].line_fee).toBe(600)
  })

  it('separates the paid labor lines from the $0 product lines', () => {
    const r = parseIpoText(OPENER_AND_DOOR)
    const paid = r.items.filter(i => i.line_fee > 0).map(i => i.item_number)
    expect(paid).toEqual(['FIR500', 'FIR010', 'FIR1010'])
    expect(r.items.filter(i => i.line_fee === 0)).toHaveLength(4)
  })

  it('returns an empty, not-ok result for text that is not an IPO', () => {
    const r = parseIpoText('Some other Clopay document\nwith no line item table.')
    expect(r.items).toEqual([])
    expect(r.ok).toBe(false)
  })
})

describe('isIpoDoc', () => {
  it('recognizes IPOs by docType or IP_ filename prefix', () => {
    expect(isIpoDoc('IP_7151173_3753297.pdf')).toBe(true)
    expect(isIpoDoc('142432482-IP_7151173_3753297.pdf')).toBe(true)
    expect(isIpoDoc('anything.pdf', 'New IPO')).toBe(true)
    expect(isIpoDoc('SC_123.pdf', 'Compltd SC')).toBe(false)
    expect(isIpoDoc(null)).toBe(false)
  })
})

// The fixtures above are one text extractor's output; production uses unpdf. These are the
// SAME four PDFs run through unpdf (whose line breaking differs slightly), so the parser is
// proven against the exact text shape it will see at runtime.
describe('parseIpoText against production (unpdf) extraction', () => {
  const EXPECTED: Record<string, { items: number; total: number; order: string }> = {
    '142432482IP_7151173_3753297.pdf': { items: 2, total: 100, order: '181194873' },
    '141639396IP_7090501_3724925.pdf': { items: 4, total: 600, order: '181193343' },
    '142525779IP_7157911_3751849.pdf': { items: 7, total: 478, order: '181194831' },
    '142917443IP_7186054_3754701.pdf': { items: 6, total: 532, order: '181195368' },
  }
  for (const [name, text] of Object.entries(unpdfTexts as Record<string, string>)) {
    it(`parses ${name} identically`, () => {
      const e = EXPECTED[name]
      const r = parseIpoText(text)
      expect(r.ok).toBe(true)
      expect(r.items).toHaveLength(e.items)
      expect(r.totalFee).toBeCloseTo(e.total, 2)
      expect(r.orderNumber).toBe(e.order)
    })
  }

  it('reassembles the split item number from unpdf output too', () => {
    const r = parseIpoText((unpdfTexts as Record<string, string>)['141639396IP_7090501_3724925.pdf'])
    expect(r.items[0].item_number).toBe('CAN212-CD*R498920')
  })
})

// ── Multi-IPO documents ─────────────────────────────────────────────────────
// A real Clopay PDF can bundle one complete IPO per page (a multi-door job), and Clopay
// attaches the same bundle to EVERY order in the group. Parsing only the first TOTAL
// attributed a sibling door's money to the wrong order — e.g. EASTMAN KAREN's order
// 181194157 reported $458.00 (its sibling's total) instead of its own $532.00.
const BUNDLE_3 = (multipage as Record<string, string>)['18281413-142732803.pdf'] // COOREY PETE
const BUNDLE_2 = (multipage as Record<string, string>)['8be248ea-141909760.pdf'] // EASTMAN KAREN

describe('parseIpoDocument (bundled multi-order IPOs)', () => {
  it('splits a 3-order bundle into three independently-correct IPOs', () => {
    const secs = parseIpoDocument(BUNDLE_3)
    expect(secs).toHaveLength(3)
    expect(secs.map(s => s.orderNumber)).toEqual(['181194840', '181194841', '181195037'])
    expect(secs.map(s => s.poNumber)).toEqual(['68443644', '68443645', '68443705'])
    expect(secs.map(s => s.totalFee)).toEqual([458, 458, 125])
    for (const s of secs) {
      expect(s.ok).toBe(true) // each page balances against its OWN stated total
      expect(s.items.length).toBeGreaterThan(0)
    }
  })

  it('splits a 2-order bundle and keeps each order distinct', () => {
    const secs = parseIpoDocument(BUNDLE_2)
    expect(secs).toHaveLength(2)
    expect(secs.map(s => s.orderNumber)).toEqual(['181194156', '181194157'])
    expect(secs.map(s => s.totalFee)).toEqual([458, 532])
  })

  it('REGRESSION: picks each order its OWN total, not the first page found', () => {
    // The shipped bug: parseIpoText on the whole document returned page 1 with ok=true,
    // so the checksum passed while the money belonged to a different order.
    const whole = parseIpoText(BUNDLE_2)
    expect(whole.orderNumber).toBe('181194156')
    expect(whole.totalFee).toBe(458)

    const secs = parseIpoDocument(BUNDLE_2)
    expect(sectionForOrder(secs, '181194157')?.totalFee).toBe(532) // the correct answer
    expect(sectionForOrder(secs, '181194156')?.totalFee).toBe(458)
    expect(sectionForOrder(secs, '181195037')).toBeNull()          // not in this document
  })

  it('returns a single section for an ordinary one-order IPO', () => {
    const secs = parseIpoDocument(SIMPLE_TWO_LINE)
    expect(secs).toHaveLength(1)
    expect(secs[0].orderNumber).toBe('181194873')
    expect(secs[0].totalFee).toBe(100)
  })

  it('exposes the sibling orders that the HD portal never lists', () => {
    // 181194840 / 181194841 exist only inside this document — the portal shows 181195037.
    const found = parseIpoDocument(BUNDLE_3).map(s => s.orderNumber)
    expect(found).toContain('181194840')
    expect(found).toContain('181194841')
  })
})
