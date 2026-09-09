import { describe, it, expect } from 'vitest'
import { toSfDate, toSfTime, findScheduleCandidates, isMapped, buildScheduleBody } from '../chrome-extension/sf-remittance/sf-schedule.js'

// The extension writes a Genie appointment into SF's job edit form the way sf-lines.js writes
// line items: echo the form as it stands, change only our fields, flip only our section flag.
const MAP = { startDate: 'Job[start_date]', windowStart: 'Job[tf_start]', windowEnd: 'Job[tf_end]', dateFormat: 'MM/DD/YYYY', timeFormat: 'h:mm A' }
const FORM: Array<[string, string]> = [
  ['inPage', '1'], ['Job[customer_id]', '42'], ['Job[start_date]', '09/01/2026'], ['Job[tf_start]', '8:00 AM'], ['Job[tf_end]', '12:00 PM'],
  ['Job[description]', 'a & b'], ['jobStartDateModified', '0'], ['jobChargesModified', '0'], ['lastUpdated', '2026-09-01 10:00:00'],
]

describe('date and time formats', () => {
  it('renders the form formats from what we store', () => {
    expect(toSfDate('2026-09-15')).toBe('09/15/2026')
    expect(toSfDate('2026-09-15', 'YYYY-MM-DD')).toBe('2026-09-15')
    expect(toSfTime('08:00')).toBe('8:00 AM')
    expect(toSfTime('12:00')).toBe('12:00 PM')
    expect(toSfTime('00:30')).toBe('12:30 AM')
    expect(toSfTime('13:05', 'HH:mm')).toBe('13:05')
  })
  it('refuses malformed values rather than writing them into a job', () => {
    expect(() => toSfDate('9/15/26')).toThrow()
    expect(() => toSfTime('8am')).toThrow()
  })
})

describe('field discovery for the dry run', () => {
  it('lists date/time-shaped fields with their current values, and skips the section flags', () => {
    const c = findScheduleCandidates(FORM)
    expect(c.map((x: { name: string }) => x.name)).toEqual(['Job[start_date]', 'Job[tf_start]', 'Job[tf_end]', 'lastUpdated'])
    expect(c[0].value).toBe('09/01/2026')
  })
})

describe('isMapped', () => {
  it('needs the date field, and the window fields only when a window is written', () => {
    expect(isMapped(FORM, MAP, false)).toBe(true)
    expect(isMapped(FORM, MAP, true)).toBe(true)
    expect(isMapped(FORM, { ...MAP, windowEnd: null }, true)).toBe(false)
    expect(isMapped(FORM, { ...MAP, windowEnd: null }, false)).toBe(true)
  })
  it('is false until FIELD_MAP is confirmed — the default state refuses to post', () => {
    expect(isMapped(FORM, { startDate: null, windowStart: null, windowEnd: null }, false)).toBe(false)
  })
  it('is false when the mapped name is not actually on this form', () => {
    expect(isMapped(FORM, { ...MAP, startDate: 'Job[nope]' }, false)).toBe(false)
  })
})

describe('buildScheduleBody', () => {
  const parse = (body: string) => Object.fromEntries(body.split('&').map(p => p.split('=').map(decodeURIComponent)))

  it('echoes every other field untouched and replaces only ours', () => {
    const b = parse(buildScheduleBody(FORM, MAP, { date: '2026-09-15', windowStart: '08:00', windowEnd: '12:00' }))
    expect(b['Job[customer_id]']).toBe('42')
    expect(b['Job[description]']).toBe('a & b')
    expect(b['lastUpdated']).toBe('2026-09-01 10:00:00')   // SF's own concurrency guard, echoed
    expect(b['Job[start_date]']).toBe('09/15/2026')
    expect(b['Job[tf_start]']).toBe('8:00 AM')
    expect(b['Job[tf_end]']).toBe('12:00 PM')
  })
  it('flips only the start-date section flag', () => {
    const b = parse(buildScheduleBody(FORM, MAP, { date: '2026-09-15', windowStart: null, windowEnd: null }))
    expect(b['jobStartDateModified']).toBe('1')
    for (const k of ['jobChargesModified', 'jobTechsModified', 'jobStatusModified', 'jobNotesModified', 'jobLocationModified']) expect(b[k]).toBe('0')
  })
  it('leaves the window fields alone when the booking is "any time"', () => {
    const b = parse(buildScheduleBody(FORM, MAP, { date: '2026-09-15', windowStart: null, windowEnd: null }))
    expect(b['Job[tf_start]']).toBeUndefined()
    expect(b['Job[tf_end]']).toBeUndefined()
  })
})
