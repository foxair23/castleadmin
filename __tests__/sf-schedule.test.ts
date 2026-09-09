import { describe, it, expect } from 'vitest'
import { toSfDate, toSfTime, windowFor, jobUpdatedAtFromPage, statusIdFromPage, statusSnippet, buildSchedulePayloads, postSucceeded, DEFAULT_WINDOW } from '../chrome-extension/sf-remittance/sf-schedule.js'

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

describe('reading the job page', () => {
  it('finds the concurrency token in the forms SF is known to use', () => {
    expect(jobUpdatedAtFromPage(`<input type="hidden" name="jobUpdatedAt" value="cNlIOo3LgNX_adigHXhhV0quYKS2-kfJ9ftVZSpF2A4">`)).toBe('cNlIOo3LgNX_adigHXhhV0quYKS2-kfJ9ftVZSpF2A4')
    expect(jobUpdatedAtFromPage(`var cfg = { jobUpdatedAt: 'cNlIOo3LgNX_adigHXhhV0quYKS2-kfJ9ftVZSpF2A4' }`)).toBe('cNlIOo3LgNX_adigHXhhV0quYKS2-kfJ9ftVZSpF2A4')
    expect(jobUpdatedAtFromPage('<html>nothing</html>')).toBeNull()
  })
  it('finds the Scheduled status id whatever the control looks like', () => {
    expect(statusIdFromPage(`<option value="1018744944">Unscheduled</option><option value="1018744945">Scheduled</option>`)).toBe('1018744945')
    expect(statusIdFromPage(`<li data-value="1018744945" class="x"> Scheduled </li>`)).toBe('1018744945')
    expect(statusIdFromPage(`<a href="#" data-status-id="1018744945" class="status-item">Scheduled</a>`)).toBe('1018744945')
    expect(statusIdFromPage(`<kendo-item data-kendo-id="1018744945" role="option">Scheduled</kendo-item>`)).toBe('1018744945')
    expect(statusIdFromPage(`var statuses = [{"id":1018744944,"name":"Unscheduled"},{"id":1018744945,"name":"Scheduled"}]`)).toBe('1018744945')
    expect(statusIdFromPage(`[{name:"Scheduled", color:"#0f0", id:"1018744945"}]`)).toBe('1018744945')
  })
  it('does not mistake Unscheduled or Rescheduled for Scheduled, and returns null when absent', () => {
    expect(statusIdFromPage(`<option value="1018744944">Unscheduled</option>`)).toBeNull()
    expect(statusIdFromPage(`<option value="1">Rescheduled</option>`)).toBeNull()
    expect(statusIdFromPage(`<html>no statuses here</html>`)).toBeNull()
  })
  it('quotes the page around the word when nothing parses, so the next run shows the markup', () => {
    expect(statusSnippet(`<div class="weird-widget"><span data-x="9">Scheduled</span></div>`)).toContain('weird-widget')
    expect(statusSnippet(`<html>nothing</html>`)).toMatch(/does not appear/)
  })
})

describe('buildSchedulePayloads', () => {
  const parse = (body: string) => Object.fromEntries(body.split('&').map(p => p.split('=').map(decodeURIComponent)))
  const P = buildSchedulePayloads({ jobId: 'K1UHlU2w47', date: '2026-09-15', windowStart: null, windowEnd: null, jobUpdatedAt: 'tok_123', statusId: '1018744945' })

  it('posts date, then window, then status', () => {
    expect(P.map(p => p.step)).toEqual(['date', 'window', 'status'])
    expect(P.map(p => p.path)).toEqual(['/jobs/changeJobDatePopup', '/jobs/changeJobTimePopupXedit', '/jobs/updateJobStatus'])
  })
  it('matches the captured date body', () => {
    expect(parse(P[0].body)).toEqual({ name: 'startdatepicker', value: '15-09-2026', pk: '1', jobId: 'K1UHlU2w47', updateChildrenJobs: '0', responseFormat: 'json' })
  })
  it('matches the captured window body, with the 8-to-4 default', () => {
    expect(parse(P[1].body)).toEqual({ name: 'xeditTime-timeRange', 'value[time_frame_promised_start]': '08:00 am', 'value[time_frame_promised_end]': '04:00 pm', pk: '1', jobId: 'K1UHlU2w47', updateChildrenJobs: '0' })
  })
  it('matches the captured status body, carrying the page token', () => {
    expect(parse(P[2].body)).toEqual({ name: 'statusManual', value: '1018744945', pk: '1', jobId: 'K1UHlU2w47', jobUpdatedAt: 'tok_123', accept: 'html', updateChildrenJobs: '0' })
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
