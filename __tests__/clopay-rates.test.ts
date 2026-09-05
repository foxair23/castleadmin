import { describe, it, expect } from 'vitest'
import { unitFee, compareToSchedule, variancePatch } from '@/lib/vendor-orders/clopay-rates'

// The agreed rates for the codes that appear in the production IPO fixtures.
const SCHEDULE = new Map<string, number>([
  ['FIR010', 342], ['FIR020', 416], ['FIR500', 124], ['FIR670', 104], ['FIR930', 154],
])

describe('unitFee', () => {
  // The IPO prints a LINE TOTAL, the schedule is a UNIT rate. Comparing the two directly
  // made FIR930 (quantity 4, $600) look like a $446 discrepancy instead of $4 a unit.
  it('divides the line total by quantity', () => {
    expect(unitFee(600, 4)).toBe(150)
    expect(unitFee(338, 1)).toBe(338)
  })

  it('treats a missing or zero quantity as one', () => {
    expect(unitFee(100, null)).toBe(100)
    expect(unitFee(100, 0)).toBe(100)   // never divide by zero
  })

  it('rounds to cents', () => {
    expect(unitFee(100, 3)).toBe(33.33)
  })
})

describe('compareToSchedule', () => {
  it('reports the shortfall against the agreed rate', () => {
    expect(compareToSchedule(338, 1, 342).variance).toBe(-4)
    expect(compareToSchedule(600, 4, 154).variance).toBe(-4)   // per unit, not per line
  })

  it('reports an overpayment as positive', () => {
    expect(compareToSchedule(350, 1, 342).variance).toBe(8)
  })

  it('is exactly zero when the rate matches', () => {
    expect(compareToSchedule(342, 1, 342).variance).toBe(0)
  })

  it('has no variance for a code with no agreed rate', () => {
    // Doors, openers and parts appear on an IPO at $0.00 and are not in the labor schedule;
    // calling those a variance would flag every order.
    const r = compareToSchedule(0, 1, null)
    expect(r.variance).toBeNull()
    expect(r.unitFee).toBe(0)
  })
})

describe('variancePatch', () => {
  it('matches the code regardless of case or padding', () => {
    expect(variancePatch(SCHEDULE, ' fir010 ', 338, 1).rate_variance).toBe(-4)
  })

  it('leaves unrated codes null but still records the unit fee', () => {
    const p = variancePatch(SCHEDULE, 'DC13', 0, 1)
    expect(p.schedule_rate).toBeNull()
    expect(p.rate_variance).toBeNull()
    expect(p.unit_fee).toBe(0)
  })

  it('reproduces the $4 shortfall seen across the real fixtures', () => {
    // Every labor line in the captured IPOs is exactly one $4 adjustment short of the
    // schedule effective 2026-06-29.
    for (const [code, fee, qty] of [['FIR010', 338, 1], ['FIR020', 412, 1], ['FIR500', 120, 1],
                                    ['FIR670', 100, 1], ['FIR930', 600, 4]] as const) {
      expect(variancePatch(SCHEDULE, code, fee, qty).rate_variance, code).toBe(-4)
    }
  })

  it('handles a null item number', () => {
    expect(variancePatch(SCHEDULE, null, 100, 1).rate_variance).toBeNull()
  })
})
