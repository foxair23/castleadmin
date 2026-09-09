// Write a Genie appointment onto an existing Service Fusion job.
//
// Service Fusion's REST API cannot modify a job that already exists — PUT /jobs/{id} answers
// 405, "this url can only handle GET, HEAD, OPTIONS" — so, exactly as payments and IPO line
// items do, this drives SF's own web session: open the job edit form, change the schedule
// fields, post the form back as it stands. Runs in the service worker (no DOM).
//
// Flow, the same one sf-lines.js has verified live:
//   1. resolveJobId(jobNumber)   — global search → the hashed web id /jobs/jobEdit wants
//   2. GET  /jobs/jobEdit?id=…   — the whole edit form
//   3. parseFormFields(html)     — every field, so the post is the form as it stands
//   4. set the date (and window) fields, flip ONLY jobStartDateModified
//   5. POST /jobs/jobEdit?id=…   — 302 → jobView on success
//
// THE ONE THING NOT YET KNOWN: the exact names of the schedule fields on that form. They are
// discovered by a dry run — every date/time-shaped field and its current value comes back in
// the trace — and then pinned in FIELD_MAP below. Until FIELD_MAP is filled in, live mode
// refuses to post: a form we cannot address is not a form we should save.

import { sfFetch, enc, parseFormFields, resolveJobId } from './sf-lines.js'

/** Exact form field names, confirmed from a dry run. null = not yet confirmed → never post. */
export const FIELD_MAP = {
  startDate: null,      // e.g. 'Job[start_date]'
  windowStart: null,    // e.g. 'Job[time_frame_promised_start]'
  windowEnd: null,      // e.g. 'Job[time_frame_promised_end]'
  dateFormat: 'MM/DD/YYYY',   // what the form's current value looks like in the dry run
  timeFormat: 'h:mm A',
}

const pad = (n) => String(n).padStart(2, '0')

/** YYYY-MM-DD → the form's date format. */
export function toSfDate(iso, fmt = FIELD_MAP.dateFormat) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '')
  if (!m) throw new Error(`bad appointment date ${iso}`)
  const [, y, mo, d] = m
  return fmt === 'YYYY-MM-DD' ? `${y}-${mo}-${d}` : `${mo}/${d}/${y}`
}

/** HH:MM (24h) → the form's time format. */
export function toSfTime(hhmm, fmt = FIELD_MAP.timeFormat) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '')
  if (!m) throw new Error(`bad window time ${hhmm}`)
  const h = Number(m[1]), min = m[2]
  if (fmt === 'HH:mm') return `${pad(h)}:${min}`
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${min} ${ampm}`
}

/** Fields that could be the schedule, for the dry-run trace. The *Modified flags are section
 *  switches, not values, so they are left out. Values are included: an existing appointment
 *  on the job shows the format the form expects. */
export function findScheduleCandidates(fields) {
  return fields
    .filter(([k]) => /date|time|promis|window|arriv|start|end|slot/i.test(k) && !/Modified$/i.test(k))
    .slice(0, 60)
    .map(([name, value]) => ({ name, value: String(value ?? '').slice(0, 40) }))
}

/** Are the fields we intend to write actually on this form? Window fields only matter when a
 *  window is being written. */
export function isMapped(fields, map, needWindow) {
  const names = new Set(fields.map(([k]) => k))
  if (!map.startDate || !names.has(map.startDate)) return false
  if (needWindow && (!map.windowStart || !map.windowEnd || !names.has(map.windowStart) || !names.has(map.windowEnd))) return false
  return true
}

/** The form as it stands, with the schedule fields replaced and only that section flagged
 *  modified — every other section stays 0 so SF leaves it exactly as it found it. */
export function buildScheduleBody(fields, map, { date, windowStart, windowEnd }) {
  const ours = new Set([map.startDate, map.windowStart, map.windowEnd].filter(Boolean))
  const parts = []
  for (const [k, v] of fields) {
    if (ours.has(k) || /^job\w*Modified$/.test(k)) continue
    parts.push(`${enc(k)}=${enc(v)}`)
  }
  const flags = {
    jobTableValuesModified: 0, jobContactsModified: 0, jobStartDateModified: 1,
    jobChargesModified: 0, jobChargesProductsModified: 0,
    jobChargesDriveModified: 0, jobChargesExpensesModified: 0, jobDocumentsModified: 0,
    jobTasksModified: 0, jobTechsModified: 0, jobUsersModified: 0, jobLocationModified: 0,
    jobEquipmentsModified: 0, jobNotesModified: 0, jobCustomFieldModified: 0,
    jobJobNotesModified: 0, jobStatusModified: 0,
  }
  for (const [k, v] of Object.entries(flags)) parts.push(`${k}=${v}`)
  parts.push(`${enc(map.startDate)}=${enc(toSfDate(date, map.dateFormat))}`)
  if (windowStart && windowEnd && map.windowStart && map.windowEnd) {
    parts.push(`${enc(map.windowStart)}=${enc(toSfTime(windowStart, map.timeFormat))}`)
    parts.push(`${enc(map.windowEnd)}=${enc(toSfTime(windowEnd, map.timeFormat))}`)
  }
  return parts.join('&')
}

/** Write one appointment. `dryRun` returns the candidates and the body without posting.
 *  `needsMapping: true` means FIELD_MAP is not (fully) confirmed for this form — the caller
 *  must leave the item queued rather than report a failure. */
export async function setJobSchedule({ jobNumber, date, windowStart, windowEnd, dryRun = false }) {
  const trace = []
  if (!jobNumber) throw new Error('jobNumber required')
  if (!date) throw new Error('date required')

  const jobId = await resolveJobId(jobNumber, trace)
  const page = await sfFetch(`/jobs/jobEdit?id=${enc(jobId)}`)
  trace.push({ step: 'openForm', status: page.status, bytes: page.text.length })
  if (page.loginRedirect) throw new Error('SF session expired — sign in to admin.servicefusion.com')

  const fields = parseFormFields(page.text)
  trace.push({ step: 'parseForm', fields: fields.length })

  const needWindow = !!(windowStart && windowEnd)
  const candidates = findScheduleCandidates(fields)
  const mapped = isMapped(fields, FIELD_MAP, needWindow)
  trace.push({ step: 'mapFields', mapped, needWindow, candidates })

  if (dryRun) {
    return { ok: true, dryRun: true, jobId, mapped, candidates, bodyPreview: mapped ? buildScheduleBody(fields, FIELD_MAP, { date, windowStart, windowEnd }).slice(0, 3000) : null, trace }
  }
  if (!mapped) {
    return { ok: false, needsMapping: true, reason: 'schedule fields are not confirmed for this form — run a dry run and fill FIELD_MAP in sf-schedule.js', candidates, trace }
  }

  const body = buildScheduleBody(fields, FIELD_MAP, { date, windowStart, windowEnd })
  const res = await sfFetch(`/jobs/jobEdit?id=${enc(jobId)}`, { method: 'POST', body, follow: true })
  trace.push({ step: 'save', status: res.status, url: res.url })
  const ok = /\/jobs\/jobView/.test(res.url || '')
  if (!ok) throw new Error(`save did not land on jobView (status ${res.status}, url ${res.url || 'n/a'})`)
  return { ok: true, jobId, trace }
}
