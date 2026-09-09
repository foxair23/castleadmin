// Write a Genie appointment onto an existing Service Fusion job.
//
// Service Fusion's REST API cannot modify a job that exists — PUT /jobs/{id} answers 405 —
// so this drives SF's own web session, as payments and IPO line items already do. It does
// NOT repost the job edit form: the job VIEW page has inline editors for the date, the
// arrival window and the status, each a small AJAX call of its own. Captured from a real
// session (2026-09-08), all POST, urlencoded, X-Requested-With: XMLHttpRequest:
//
//   /jobs/changeJobDatePopup      name=startdatepicker&value=DD-MM-YYYY&pk=1&jobId=…
//                                 &updateChildrenJobs=0&responseFormat=json
//   /jobs/changeJobTimePopupXedit name=xeditTime-timeRange
//                                 &value[time_frame_promised_start]=08:00 am
//                                 &value[time_frame_promised_end]=04:00 pm&pk=1&jobId=…
//                                 &updateChildrenJobs=0
//
// `jobId` is the hashed web id (global search → resolveJobId). Neither call needs SF's
// concurrency token, so the job page itself is never fetched.
//
// Business rules: a booking with no window ("any time — tech will call ahead") is written
// as 8:00 am – 4:00 pm. The status is deliberately LEFT ALONE — the job stays Unscheduled so
// the dispatcher picks a tech and marks it Scheduled, which is their call to make.

import { sfFetch, enc, resolveJobId } from './sf-lines.js'

export const DEFAULT_WINDOW = { start: '08:00', end: '16:00' }

const pad = (n) => String(n).padStart(2, '0')

/** YYYY-MM-DD → DD-MM-YYYY, the date picker's wire format. */
export function toSfDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '')
  if (!m) throw new Error(`bad appointment date ${iso}`)
  return `${m[3]}-${m[2]}-${m[1]}`
}

/** HH:MM (24h) → "hh:mm am", zero-padded lower-case, as the time editor sends it. */
export function toSfTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '')
  if (!m) throw new Error(`bad window time ${hhmm}`)
  const h = Number(m[1]), min = m[2]
  if (h > 23 || Number(min) > 59) throw new Error(`bad window time ${hhmm}`)
  const ampm = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${pad(h12)}:${min} ${ampm}`
}

/** The window to write: the booking's, or the default when the customer chose "any time". */
export function windowFor(windowStart, windowEnd) {
  return windowStart && windowEnd ? { start: windowStart, end: windowEnd } : { ...DEFAULT_WINDOW }
}

/** The two posts, in the order they are made. Pure, so the dry run can show exactly them. */
export function buildSchedulePayloads({ jobId, date, windowStart, windowEnd }) {
  const w = windowFor(windowStart, windowEnd)
  const common = `pk=1&jobId=${enc(jobId)}&updateChildrenJobs=0`
  return [
    { step: 'date', path: '/jobs/changeJobDatePopup', body: `name=startdatepicker&value=${enc(toSfDate(date))}&${common}&responseFormat=json` },
    { step: 'window', path: '/jobs/changeJobTimePopupXedit', body: `name=xeditTime-timeRange&${enc('value[time_frame_promised_start]')}=${enc(toSfTime(w.start))}&${enc('value[time_frame_promised_end]')}=${enc(toSfTime(w.end))}&${common}` },
  ]
}

/** Did an inline-editor post succeed? A login bounce or a non-200 is a failure; so is a JSON
 *  body that says so. Anything else SF returned 200 for is taken as saved. */
export function postSucceeded(res) {
  if (res.loginRedirect || res.status !== 200) return false
  const t = (res.text || '').trim()
  if (t.startsWith('{')) {
    try { const j = JSON.parse(t); if (j.success === false || j.error || j.errors) return false } catch { /* not JSON after all */ }
  }
  return !/\berror\b/i.test(t.slice(0, 200)) || /"error"\s*:\s*(null|false|"")/.test(t)
}

/** Write one appointment. `dryRun` returns the payloads without posting anything. */
export async function setJobSchedule({ jobNumber, date, windowStart, windowEnd, dryRun = false }) {
  const trace = []
  if (!jobNumber) throw new Error('jobNumber required')
  if (!date) throw new Error('date required')

  const jobId = await resolveJobId(jobNumber, trace)
  const payloads = buildSchedulePayloads({ jobId, date, windowStart, windowEnd })
  if (dryRun) return { ok: true, dryRun: true, jobId, window: windowFor(windowStart, windowEnd), payloads, trace }

  for (const p of payloads) {
    const res = await sfFetch(p.path, { method: 'POST', xhr: true, body: p.body })
    trace.push({ step: p.step, status: res.status, response: (res.text || '').slice(0, 160) })
    if (!postSucceeded(res)) throw new Error(`${p.step} was not saved (HTTP ${res.status}): ${(res.text || '').slice(0, 200).replace(/\s+/g, ' ')}`)
  }
  return { ok: true, jobId, window: windowFor(windowStart, windowEnd), trace }
}
