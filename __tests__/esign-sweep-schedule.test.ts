import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { customerStageDue, type DueInput } from '@/lib/esign/eligibility'

// The customer heads-up is meant to go out at 8:00 AM Pacific. Two separate things have to
// agree for that: the cron that wakes the sweep (UTC, and Vercel does not do daylight
// saving), and the eligibility rule's own 8am gate. Either one drifting breaks the promise
// quietly, so both are asserted here against each other.

const cron = (): string => {
  const v = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as { crons: Array<{ path: string; schedule: string }> }
  const row = v.crons.find(c => c.path === '/api/cron/esign-sweep')
  if (!row) throw new Error('the esign-sweep cron is gone')
  return row.schedule
}

/** The UTC hours a 5-field cron fires on, for schedules of the form "M h1-h2,h3-h4 * * *". */
function utcHours(schedule: string): number[] {
  const [minute, hours] = schedule.split(' ')
  expect(minute, 'the sweep must fire on the hour, or "8am" is really "8-something"').toBe('0')
  const out = new Set<number>()
  for (const part of hours.split(',')) {
    const [a, b] = part.split('-').map(Number)
    for (let h = a; h <= (Number.isFinite(b) ? b : a); h++) out.add(h)
  }
  return [...out].sort((x, y) => x - y)
}

const toPt = (utcHour: number, offset: number) => (utcHour - offset + 24) % 24

describe('the morning send really lands at 8am PT', () => {
  it('fires at 8:00 PT in summer and in winter alike', () => {
    const hours = utcHours(cron())
    // Pacific is UTC-7 in summer and UTC-8 in winter; the cron is fixed, the offset is not.
    expect(hours.map(h => toPt(h, 7))).toContain(8)
    expect(hours.map(h => toPt(h, 8))).toContain(8)
  })
  it('the extra winter run at 7am PT sends nothing, so the rule holds either way', () => {
    const base: DueInput = {
      status: 'prepared', created_at: '2026-01-10T12:00:00Z', enabled_at: '2026-01-01T00:00:00Z',
      customer_sent_at: null, customer_asked_at: null, customer_reminded_at: null, customer_signed_at: null,
      start_date: '2026-01-15', today: '2026-01-15', hour: 7, sof: 'needed',
    }
    expect(customerStageDue(base)).toBeNull()                      // 7am PT: too early, by design
    expect(customerStageDue({ ...base, hour: 8 })).toBe('heads_up') // 8am PT: away it goes
  })
  it('covers the working day, not just the morning', () => {
    const hours = utcHours(cron())
    const ptSummer = hours.map(h => toPt(h, 7))
    expect(Math.max(...ptSummer)).toBeGreaterThanOrEqual(17)       // the ask and the reminder still have all day
  })
})
