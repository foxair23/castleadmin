import { describe, it, expect } from 'vitest'
import { parseStsOrders } from '@/lib/clopay-sts/parse'

// The 18 Sep ROLLUP: three orders the DC listed on separate lines, which arrived collapsed
// onto one after the forward. The parser used to read that as ONE order carrying the other
// two inside its PO text, so the STS tab showed a single row and one DC request went out
// asking about all three at once.
const ROLLUP_ONE_LINE =
  'Hello The following order(s) have arrived and will be available for pickup starting Friday Sept. 18th. ' +
  '181195300 PO L PILCHER MARK C/O STS 1018 181195102 PO BUEHLER, BRETTON C/O STS 6634 ' +
  '181195383 PO CACY, RYAN C/O STS 1848 Thank you for your order, we appreciate your business. San Diego Team.'

const ROLLUP_MULTILINE = `Hello

The following order(s) have arrived and will be available for pickup starting Friday Sept. 18th.

 181195300 PO L PILCHER MARK C/O STS 1018
181195102 PO BUEHLER, BRETTON C/O STS 6634
181195383 PO CACY, RYAN C/O STS 1848

Thank you for your order, we appreciate your business.
San Diego Team.`

describe('parseStsOrders', () => {
  it('splits three orders collapsed onto one line', () => {
    const out = parseStsOrders(ROLLUP_ONE_LINE, null)
    expect(out.map(o => o.external_id)).toEqual(['181195300', '181195102', '181195383'])
    expect(out.map(o => o.customer_po)).toEqual([
      'L PILCHER MARK C/O STS 1018',
      'BUEHLER, BRETTON C/O STS 6634',
      'CACY, RYAN C/O STS 1848',
    ])
  })
  it('reads the same three when the DC keeps them on their own lines', () => {
    const out = parseStsOrders(ROLLUP_MULTILINE, null)
    expect(out.map(o => o.external_id)).toEqual(['181195300', '181195102', '181195383'])
    expect(out[2].customer_po).toBe('CACY, RYAN C/O STS 1848')
  })
  it('does not let the sign-off run into the last order', () => {
    const [last] = parseStsOrders('181195383 PO CACY, RYAN C/O STS 1848 Thank you for your order, we appreciate your business. San Diego Team.', null)
    expect(last.customer_po).toBe('CACY, RYAN C/O STS 1848')
  })
  it('still reads a single order however it is written', () => {
    expect(parseStsOrders('Order #181191036 - PO STS ALEXANDER #680', null)[0])
      .toMatchObject({ external_id: '181191036', customer_po: 'STS ALEXANDER #680' })
  })
  it('keeps ignoring orders that are not STS', () => {
    expect(parseStsOrders('181195300 PO L PILCHER MARK C/O STS 1018 181199999 PO SMITH, JOHN #4102', null).map(o => o.external_id))
      .toEqual(['181195300'])
  })
  it('does not repeat an order named twice', () => {
    const out = parseStsOrders('181195300 PO PILCHER C/O STS 1018\n181195300 PO PILCHER C/O STS 1018', null)
    expect(out).toHaveLength(1)
  })
  it('reads the HTML body when there is no text part', () => {
    const html = '<p><i>181195300 PO L PILCHER MARK C/O STS 1018</i><br><i>181195102 PO BUEHLER, BRETTON C/O STS 6634</i></p>'
    expect(parseStsOrders(null, html).map(o => o.external_id)).toEqual(['181195300', '181195102'])
  })
})
