import { describe, it, expect } from 'vitest'
import { toSfDate, toSfTime, windowFor, buildSchedulePayloads, postSucceeded, DEFAULT_WINDOW } from '../chrome-extension/sf-remittance/sf-schedule.js'

// Wire formats and body shapes are pinned to a real capture of the job view page's inline
// editors (2026-09-08). Change them only against a new capture.
describe('wire formats', () => {
  it('date is DD-MM-YYYY', () => {
    expect(toSfDate('2026-09-15')).toBe('15-09-2026')
    expect(() => toSfDate('09/15/2026')).toThrow()
  })
  it('time is zero-padded 12-hour with lower-case am/pm', () => {
    expect(toSfTime('08:00')).toBe('08:00 am')
    expect(toSfTime('16:00')).toBe('04:00 pm')
    expect(toSfTime('12:00')).toBe('12:00 pm')
    expect(toSfTime('00:30')).toBe('12:30 am')
    expect(() => toSfTime('8am')).toThrow()
    expect(() => toSfTime('25:00')).toThrow()
  })
})

describe('business rules', () => {
  it('"any time" becomes the 8-to-4 window', () => {
    expect(windowFor(null, null)).toEqual(DEFAULT_WINDOW)
    expect(DEFAULT_WINDOW).toEqual({ start: '08:00', end: '16:00' })
  })
  it('a chosen window is kept', () => {
    expect(windowFor('10:00', '14:00')).toEqual({ start: '10:00', end: '14:00' })
  })
})

describe('buildSchedulePayloads', () => {
  const parse = (body: string) => Object.fromEntries(body.split('&').map(p => p.split('=').map(decodeURIComponent)))
  const P = buildSchedulePayloads({ jobId: 'K1UHlU2w47', date: '2026-09-15', windowStart: null, windowEnd: null })

  it('posts the date, then the window — and never touches the status (that is dispatch\'s call)', () => {
    expect(P.map(p => p.step)).toEqual(['date', 'window'])
    expect(P.map(p => p.path)).toEqual(['/jobs/changeJobDatePopup', '/jobs/changeJobTimePopupXedit'])
    expect(P.some(p => /updateJobStatus|statusManual/.test(p.path + p.body))).toBe(false)
  })
  it('matches the captured date body', () => {
    expect(parse(P[0].body)).toEqual({ name: 'startdatepicker', value: '15-09-2026', pk: '1', jobId: 'K1UHlU2w47', updateChildrenJobs: '0', responseFormat: 'json' })
  })
  it('matches the captured window body, with the 8-to-4 default', () => {
    expect(parse(P[1].body)).toEqual({ name: 'xeditTime-timeRange', 'value[time_frame_promised_start]': '08:00 am', 'value[time_frame_promised_end]': '04:00 pm', pk: '1', jobId: 'K1UHlU2w47', updateChildrenJobs: '0' })
  })
})

describe('postSucceeded', () => {
  it('accepts a 200 with a quiet or affirmative body', () => {
    expect(postSucceeded({ status: 200, loginRedirect: false, text: '' })).toBe(true)
    expect(postSucceeded({ status: 200, loginRedirect: false, text: '{"success":true}' })).toBe(true)
    expect(postSucceeded({ status: 200, loginRedirect: false, text: '<div class="ok">Sep 15</div>' })).toBe(true)
  })
  it('rejects a login bounce, a non-200, or a body that says it failed', () => {
    expect(postSucceeded({ status: 200, loginRedirect: true, text: '' })).toBe(false)
    expect(postSucceeded({ status: 500, loginRedirect: false, text: '' })).toBe(false)
    expect(postSucceeded({ status: 200, loginRedirect: false, text: '{"success":false,"error":"Invalid date"}' })).toBe(false)
    expect(postSucceeded({ status: 200, loginRedirect: false, text: 'Error: job is locked' })).toBe(false)
  })
})
