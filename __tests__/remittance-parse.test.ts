/**
 * Deterministic remittance parsing. Fixtures are sanitized copies of the two
 * real vendor formats (Clopay + Overhead Door) — the exact Oracle BI Publisher
 * HTML structure with fabricated names/POs/amounts (no real customer or payment
 * data in the repo). We extract the text/html part (decoding quoted-printable)
 * the way Resend Inbound delivers it, then assert the parsed structure.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseRemittance, detectVendor } from '@/lib/remittance/parse'

const dir = join(__dirname, 'fixtures', 'remittance')

function decodeQP(s: string): string {
  return s.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
}
function htmlFromEml(file: string): string {
  const eml = readFileSync(join(dir, file), 'utf8')
  const idx = eml.indexOf('Content-Type: text/html')
  const rest = eml.slice(idx)
  const blank = rest.search(/\r?\n\r?\n/)
  const header = rest.slice(0, blank)
  let body = rest.slice(blank).replace(/^\r?\n\r?\n/, '')
  const end = body.search(/\r?\n------=_Part/)
  if (end >= 0) body = body.slice(0, end)
  if (/quoted-printable/i.test(header)) body = decodeQP(body)
  return body
}
const round2 = (n: number) => Math.round(n * 100) / 100

describe('detectVendor', () => {
  it('detects by sender and by content', () => {
    expect(detectVendor('accountspayable@clopay.com', '')).toBe('clopay')
    expect(detectVendor('noreply@overheaddoor.com', '')).toBe('overhead_door')
    expect(detectVendor(null, htmlFromEml('clopay-a.eml'))).toBe('clopay')
    expect(detectVendor(null, htmlFromEml('ohd-single.eml'))).toBe('overhead_door')
    expect(detectVendor('someone@unknown.com', '<p>hi</p>')).toBeNull()
  })
})

describe('Clopay parsing', () => {
  it('parses payment header + line items', () => {
    const p = parseRemittance('clopay', htmlFromEml('clopay-a.eml'))
    expect(p.payment_reference).toBe('9000001')
    expect(p.payment_amount).toBe(1973.20)
    expect(p.lines).toHaveLength(3)
    expect(p.lines[0]).toMatchObject({ po: '90000001', customer_name: 'DOE, JANE', amount: 1535.20, vendor_ref: '80000001' })
    expect(p.lines[1]).toMatchObject({ po: '90000002', customer_name: 'SMITH JOHN', amount: 338.00 })
    expect(p.lines[2]).toMatchObject({ po: '90000003', customer_name: 'ADAMS RILEY', amount: 100.00 })
    expect(round2(p.lines.reduce((s, l) => s + l.amount, 0))).toBe(p.payment_amount)
  })
  it('parses a second Clopay payment', () => {
    const p = parseRemittance('clopay', htmlFromEml('clopay-b.eml'))
    expect(p.payment_reference).toBe('9000002')
    expect(p.payment_amount).toBe(1568.00)
    expect(p.lines).toHaveLength(4)
    expect(p.lines[0]).toMatchObject({ po: '90000010', customer_name: 'BROWN CHRIS', amount: 503.00 })
    expect(p.lines.map(l => l.customer_name)).toEqual(['BROWN CHRIS', 'BROWN CHRIS', 'BROWN CHRIS', 'DAVIS PAT'])
  })
})

describe('Overhead Door parsing', () => {
  it('parses a single-line payment; PO is the pre-hyphen segment', () => {
    const p = parseRemittance('overhead_door', htmlFromEml('ohd-single.eml'))
    expect(p.payment_reference).toBe('9000003')
    expect(p.payment_amount).toBe(130.00)
    expect(p.lines).toHaveLength(1)
    expect(p.lines[0]).toMatchObject({ po: '90000101', vendor_ref: '90000101-3802192', amount: 130.00, customer_name: null })
  })
  it('parses the reference on the single-line 589709 variant', () => {
    const p = parseRemittance('overhead_door', htmlFromEml('ohd-single2.eml'))
    expect(p.payment_reference).toBe('9000004')
    expect(p.lines).toHaveLength(1)
  })
  it('parses a multi-line payment; every PO is 8 digits and lines sum to the total', () => {
    const p = parseRemittance('overhead_door', htmlFromEml('ohd-multi.eml'))
    expect(p.payment_reference).toBe('9000005')
    expect(p.payment_amount).toBe(1503.58)
    expect(p.lines).toHaveLength(11)
    expect(p.lines[0]).toMatchObject({ po: '90000102', vendor_ref: '90000102-3768347', amount: 132.00 })
    expect(p.lines.every(l => /^\d{8}$/.test(l.po ?? ''))).toBe(true)
    expect(round2(p.lines.reduce((s, l) => s + l.amount, 0))).toBe(p.payment_amount)
  })
})
