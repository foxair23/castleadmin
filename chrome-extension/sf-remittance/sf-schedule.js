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
//   /jobs/updateJobStatus         name=statusManual&value=<statusId>&pk=1&jobId=…
//                                 &jobUpdatedAt=<token>&accept=html&updateChildrenJobs=0
//
// `jobId` is the hashed web id (global search → resolveJobId). `jobUpdatedAt` is a per-job
// token on the view page — SF's concurrency guard — and the status id is read off the same
// page's status list, so neither is hardcoded to one account.
//
// Business rules: a booking with no window ("any time — tech will call ahead") is written
// as 8:00 am – 4:00 pm; every written appointment sets the status to Scheduled.

import { sfFetch, enc, resolveJobId } from './sf-lines.js'

export const DEFAULT_WINDOW = { start: '08:00', end: '16:00' }
export const SCHEDULED_STATUS_NAME = 'Scheduled'

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

/** SF's per-job concurrency token, from the view page. */
export function jobUpdatedAtFromPage(html) {
  const m = html.match(/jobUpdatedAt["']?\s*[:=]\s*["']([A-Za-z0-9_\-]{10,})["']/)
    || html.match(/name=["']jobUpdatedAt["'][^>]*value=["']([A-Za-z0-9_\-]{10,})["']/)
    || html.match(/value=["']([A-Za-z0-9_\-]{10,})["'][^>]*name=["']jobUpdatedAt["']/)
  return m ? m[1] : null
}

/** The id of a named status, from the view page — whatever the status control looks like.
 *
 *  On the job page the status is an x-editable popover (a#statusManual → a <select> built at
 *  click time), so the options are not in the markup at all: they sit in the editor's JS
 *  `source` array as { value, text } pairs. That form is tried first. Then: an element whose
 *  text is the name carrying any numeric attribute; then { id, name } JSON, either key order. */
export function statusIdFromPage(html, name = SCHEDULED_STATUS_NAME) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const tries = [
    // x-editable source: {value: 1018744945, text: "Scheduled"} — either order, quoted or not
    new RegExp(`["']?value["']?\\s*:\\s*["']?(\\d{3,})["']?[^{}]{0,200}["']?text["']?\\s*:\\s*["']${n}["']`, 'i'),
    new RegExp(`["']?text["']?\\s*:\\s*["']${n}["'][^{}]{0,200}["']?value["']?\\s*:\\s*["']?(\\d{3,})`, 'i'),
    new RegExp(`[A-Za-z_:-]+=["'](\\d{3,})["'][^<>]{0,300}>\\s*${n}\\s*<`, 'i'),
    new RegExp(`>\\s*${n}\\s*<[^<>]{0,300}?[A-Za-z_:-]+=["'](\\d{3,})["']`, 'i'),
    new RegExp(`["']?id["']?\\s*:\\s*["']?(\\d{3,})["']?[^{}]{0,200}["']?name["']?\\s*:\\s*["']${n}["']`, 'i'),
    new RegExp(`["']?name["']?\\s*:\\s*["']${n}["'][^{}]{0,200}["']?id["']?\\s*:\\s*["']?(\\d{3,})`, 'i'),
  ]
  for (const re of tries) { const m = html.match(re); if (m) return m[1] }
  return null
}

/** The page around the first occurrence of the status name — what the next run needs to
 *  see when the parse above finds nothing. Markup only; a status list holds no customer data. */
export function statusSnippet(html, name = SCHEDULED_STATUS_NAME) {
  const i = html.indexOf(name)
  if (i < 0) return `(the word "${name}" does not appear on the page)`
  return html.slice(Math.max(0, i - 220), i + 120).replace(/\s+/g, ' ')
}

/** The three posts, in the order they are made. Pure, so the dry run can show exactly them. */
export function buildSchedulePayloads({ jobId, date, windowStart, windowEnd, jobUpdatedAt, statusId }) {
  const w = windowFor(windowStart, windowEnd)
  const common = `pk=1&jobId=${enc(jobId)}&updateChildrenJobs=0`
  return [
    { step: 'date', path: '/jobs/changeJobDatePopup', body: `name=startdatepicker&value=${enc(toSfDate(date))}&${common}&responseFormat=json` },
    { step: 'window', path: '/jobs/changeJobTimePopupXedit', body: `name=xeditTime-timeRange&${enc('value[time_frame_promised_start]')}=${enc(toSfTime(w.start))}&${enc('value[time_frame_promised_end]')}=${enc(toSfTime(w.end))}&${common}` },
    { step: 'status', path: '/jobs/updateJobStatus', body: `name=statusManual&value=${enc(statusId)}&${common.replace('&updateChildrenJobs=0', '')}&jobUpdatedAt=${enc(jobUpdatedAt)}&accept=html&updateChildrenJobs=0` },
  ]
}

/** SF's concurrency refusal. The token we sent was read before our own earlier writes, so
 *  "another user" here is usually us — the cure is a fresh token, not a retry of the same. */
export function isStaleTokenResponse(text) {
  return /modified by another user/i.test(text || '')
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
export async function setJobSchedule({ jobNumber, date, windowStart, windowEnd, scheduledStatusId = null, dryRun = false }) {
  const trace = []
  if (!jobNumber) throw new Error('jobNumber required')
  if (!date) throw new Error('date required')

  const jobId = await resolveJobId(jobNumber, trace)
  const page = await sfFetch(`/jobs/jobView?id=${enc(jobId)}`)
  trace.push({ step: 'openView', status: page.status, bytes: page.text.length })
  if (page.loginRedirect) throw new Error('SF session expired — sign in to admin.servicefusion.com')

  const jobUpdatedAt = jobUpdatedAtFromPage(page.text)
  // The page is the first choice for the status id (it is exactly what the UI would send);
  // the id the app read from SF's API is the fallback. Same id space — the API's statuses
  // are the ones the page lists.
  const pageStatusId = statusIdFromPage(page.text)
  const statusId = pageStatusId ?? (scheduledStatusId ? String(scheduledStatusId) : null)
  trace.push({ step: 'readPage', jobUpdatedAt: !!jobUpdatedAt, statusId, statusSource: pageStatusId ? 'page' : (statusId ? 'api' : null) })
  if (!jobUpdatedAt) throw new Error('could not read jobUpdatedAt from the job page — SF may have changed the page')
  if (!statusId) throw new Error(`could not find the "${SCHEDULED_STATUS_NAME}" status on the job page and the app supplied none — page near the word: ${statusSnippet(page.text)}`)

  const payloads = buildSchedulePayloads({ jobId, date, windowStart, windowEnd, jobUpdatedAt, statusId })
  if (dryRun) return { ok: true, dryRun: true, jobId, window: windowFor(windowStart, windowEnd), statusId, payloads, trace }

  const post = async (p) => {
    const res = await sfFetch(p.path, { method: 'POST', xhr: true, body: p.body })
    trace.push({ step: p.step, status: res.status, response: (res.text || '').slice(0, 160) })
    return res
  }
  const fail = (p, res) => new Error(`${p.step} was not saved (HTTP ${res.status}): ${(res.text || '').slice(0, 200).replace(/\s+/g, ' ')}`)

  // Date and window first — neither carries the token.
  for (const p of payloads.filter(p => p.step !== 'status')) {
    const res = await post(p)
    if (!postSucceeded(res)) throw fail(p, res)
  }

  // Those two writes changed the job, so the token read before them is now stale and SF
  // would refuse the status post as "modified by another user". Re-read the page for the
  // current token; if SF still calls it stale (someone really was editing), refresh once more.
  let token = jobUpdatedAt
  for (let attempt = 0; attempt < 2; attempt++) {
    const again = await sfFetch(`/jobs/jobView?id=${enc(jobId)}`)
    if (again.loginRedirect) throw new Error('SF session expired — sign in to admin.servicefusion.com')
    token = jobUpdatedAtFromPage(again.text) ?? token
    trace.push({ step: 'refreshToken', attempt: attempt + 1, found: !!jobUpdatedAtFromPage(again.text) })
    const statusPayload = buildSchedulePayloads({ jobId, date, windowStart, windowEnd, jobUpdatedAt: token, statusId }).find(p => p.step === 'status')
    const res = await post(statusPayload)
    if (postSucceeded(res)) return { ok: true, jobId, window: windowFor(windowStart, windowEnd), statusId, trace }
    if (!isStaleTokenResponse(res.text) || attempt === 1) throw fail(statusPayload, res)
  }
  throw new Error('status was not saved')
}
