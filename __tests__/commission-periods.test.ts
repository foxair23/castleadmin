/**
 * Commission period engine tests (TRD §6, acceptance criteria 4 & 9).
 *
 * Verifies calendar-month periods, the clamped partial first period
 * (June 2026 from the 22nd), the pre-start cutoff, and quarterly support.
 */

import { describe, it, expect } from 'vitest'
import {
  periodForDate,
  periodForRecognitionDate,
  nextPeriod,
  listPeriods,
  dateInPeriod,
  COMMISSION_START_DATE,
} from '@/lib/commission/periods'

describe('monthly periods', () => {
  it('returns the calendar month for a date', () => {
    const p = periodForDate('2026-07-15', 'monthly')
    expect(p.start).toBe('2026-07-01')
    expect(p.end).toBe('2026-07-31')
    expect(p.key).toBe('2026-07')
    expect(p.label).toBe('July 2026')
  })

  it('handles February in a non-leap year', () => {
    const p = periodForDate('2027-02-10', 'monthly')
    expect(p.end).toBe('2027-02-28')
  })

  it('handles February in a leap year', () => {
    const p = periodForDate('2028-02-10', 'monthly')
    expect(p.end).toBe('2028-02-29')
  })
})

describe('recognition-date start cutoff (§3.5, criterion 4)', () => {
  it('first period is the full month containing the start date', () => {
    const p = periodForRecognitionDate('2026-06-25', 'monthly')!
    expect(p.start).toBe(COMMISSION_START_DATE) // 2026-06-01 (full June)
    expect(p.end).toBe('2026-06-30')
  })

  it('returns null for dates before the start date', () => {
    expect(periodForRecognitionDate('2026-05-31', 'monthly')).toBeNull()
    expect(periodForRecognitionDate('2025-12-31', 'monthly')).toBeNull()
  })

  it('does not clamp later periods', () => {
    const p = periodForRecognitionDate('2026-07-15', 'monthly')!
    expect(p.start).toBe('2026-07-01')
  })
})

describe('nextPeriod', () => {
  it('advances monthly across a year boundary', () => {
    const dec = periodForDate('2026-12-10', 'monthly')
    const jan = nextPeriod(dec)
    expect(jan.key).toBe('2027-01')
    expect(jan.start).toBe('2027-01-01')
  })

  it('advancing from the clamped first period gives a full July', () => {
    const june = periodForRecognitionDate('2026-06-25', 'monthly')!
    const july = nextPeriod(june)
    expect(july.start).toBe('2026-07-01')
    expect(july.end).toBe('2026-07-31')
  })
})

describe('listPeriods', () => {
  it('enumerates from the start through the given date, oldest first', () => {
    const periods = listPeriods('2026-09-15', 'monthly')
    expect(periods.map(p => p.key)).toEqual(['2026-06', '2026-07', '2026-08', '2026-09'])
    // first is the clamped partial month
    expect(periods[0].start).toBe(COMMISSION_START_DATE)
  })

  it('includes the first period when the through-date is inside the clamped month', () => {
    // Regression: today in June 2026 must still yield the June period even
    // though its start is clamped forward to the 22nd.
    const periods = listPeriods('2026-06-27', 'monthly')
    expect(periods.map(p => p.key)).toEqual(['2026-06'])
    expect(periods[0].start).toBe(COMMISSION_START_DATE)
  })

  it('quarterly: through-date inside the clamped first quarter still yields it', () => {
    const periods = listPeriods('2026-06-27', 'quarterly')
    expect(periods.map(p => p.key)).toEqual(['2026-Q2'])
  })
})

describe('quarterly support (criterion 9)', () => {
  it('returns the calendar quarter', () => {
    const p = periodForDate('2026-08-10', 'quarterly')
    expect(p.start).toBe('2026-07-01')
    expect(p.end).toBe('2026-09-30')
    expect(p.key).toBe('2026-Q3')
    expect(p.label).toBe('Q3 2026')
  })

  it('clamps the first quarter to the start date', () => {
    // Q2 2026 is Apr–Jun; clamped start is 2026-06-22.
    const p = periodForRecognitionDate('2026-06-25', 'quarterly')!
    expect(p.start).toBe(COMMISSION_START_DATE)
    expect(p.end).toBe('2026-06-30')
    expect(p.key).toBe('2026-Q2')
  })

  it('advances quarter to quarter', () => {
    const q3 = periodForDate('2026-08-10', 'quarterly')
    const q4 = nextPeriod(q3)
    expect(q4.key).toBe('2026-Q4')
    expect(q4.start).toBe('2026-10-01')
    expect(q4.end).toBe('2026-12-31')
  })
})

describe('dateInPeriod', () => {
  it('is inclusive of both ends', () => {
    const p = periodForDate('2026-07-15', 'monthly')
    expect(dateInPeriod('2026-07-01', p)).toBe(true)
    expect(dateInPeriod('2026-07-31', p)).toBe(true)
    expect(dateInPeriod('2026-08-01', p)).toBe(false)
  })
})
