import { describe, it, expect } from 'vitest'
import { nextAdditionalPos } from '@/lib/vendor-orders/ipo-ingest'

// Clopay cancels a PO on a change order and issues a new one, but leaves the dead PO on the
// portal row. The SF job the office made carries the NEW number, so unless we keep both, the
// row and the job never match.
describe('nextAdditionalPos', () => {
  const row = { external_id: '181181582', customer_po: null, additional_pos: [] }

  it('keeps a PO the order does not already carry', () => {
    expect(nextAdditionalPos(row, '181199001')).toEqual(['181199001'])
  })
  it('ignores the order number itself', () => {
    expect(nextAdditionalPos(row, '181181582')).toBeNull()
    expect(nextAdditionalPos(row, ' 181181582 ')).toBeNull()
  })
  it('ignores one already recorded, whatever the spacing', () => {
    expect(nextAdditionalPos({ ...row, additional_pos: ['181199001'] }, '181199001')).toBeNull()
    expect(nextAdditionalPos({ ...row, additional_pos: [' 181199001 '] }, '181199001')).toBeNull()
  })
  it('ignores the row PO and blanks', () => {
    expect(nextAdditionalPos({ ...row, customer_po: '77' }, '77')).toBeNull()
    expect(nextAdditionalPos(row, '')).toBeNull()
    expect(nextAdditionalPos(row, null)).toBeNull()
  })
  it('accumulates reissues in order, keeping the old ones matchable', () => {
    const one = nextAdditionalPos(row, 'A')!
    const two = nextAdditionalPos({ ...row, additional_pos: one }, 'B')!
    expect(two).toEqual(['A', 'B'])
  })
})
