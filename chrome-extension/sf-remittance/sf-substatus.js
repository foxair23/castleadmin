// Set a job's SUB-STATUS in Service Fusion, through the web session.
//
// Captured from a real job on 2026-09-15, so this is written from evidence rather than guessed:
//
//   POST /jobs/showSubStatusPopover   jobId=<hashed id>
//        → the popover HTML, holding <select id="jobSubStatusId"> with one <option
//          value="<numeric id>">Name</option> per sub-status. No option is marked selected,
//          so this call says what EXISTS, never what the job currently has.
//
//   POST /jobs/updateJobSubStatus     jobId=<hashed id>&jobSubStatus=<numeric id>
//        → {"color":"#f2fa0a","subStatus":"HD SOF Sent"}
//          The echo is the NEW value (verified against all three HD SOF sub-statuses), so it
//          is a receipt: we only call a write successful when the name comes back matching.
//
// Note this is a dedicated endpoint, not the job edit form. It cannot touch anything but the
// sub-status — unlike sf-lines.js, which must re-post every field and mind the dirty flags.
//
// Sub-statuses are matched BY NAME at run time, never by hardcoded id: the office can rename
// or rebuild one in SF settings, which changes its id, and a stale id would write the wrong
// label onto a customer's job.

import { sfFetch, resolveJobId, enc } from './sf-lines.js'

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }
const decode = (s) => (s ?? '').replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)

/** Loose name key, so "HD SOF Sent" still matches " hd sof  sent ". */
export const nameKey = (s) => decode(s).replace(/\s+/g, ' ').trim().toLowerCase()

/** Every sub-status the popover offers: [{ id, name }], in document order.
 *  Pure, so it can be unit-tested against the captured HTML. */
export function parseSubStatusOptions(html) {
  const text = html ?? ''
  // Prefer the select we know by id; fall back to the whole document if SF renames it, since
  // an options list we can still read beats failing outright.
  let scope = text
  const open = /<select\b[^>]*\bid=["']?jobSubStatusId["']?[^>]*>/i.exec(text)
  if (open) {
    const from = open.index + open[0].length
    const close = text.indexOf('</select>', from)
    scope = close < 0 ? text.slice(from) : text.slice(from, close)
  }
  const out = []
  for (const m of scope.matchAll(/<option\b[^>]*\bvalue=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/option>/gi)) {
    const id = m[1]
    const name = decode(m[2].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
    if (name) out.push({ id, name })
  }
  return out
}

/** The id for a sub-status name, or null when SF does not offer it. */
export function pickSubStatusId(options, name) {
  const want = nameKey(name)
  if (!want) return null
  return (options ?? []).find((o) => nameKey(o.name) === want)?.id ?? null
}

/** The sub-status SF says the job now has, from the update response. Null if unreadable. */
export function subStatusFromResponse(text) {
  try {
    const j = JSON.parse(text)
    const name = typeof j?.subStatus === 'string' ? j.subStatus : null
    return name ? { name, color: typeof j?.color === 'string' ? j.color : null } : null
  } catch { return null }
}

/** Set one job's sub-status by name. Resolves the job, reads what SF offers, writes, and
 *  only reports ok when SF echoes the name back. */
export async function setJobSubStatus({ jobNumber, subStatus, dryRun = false }) {
  const trace = []
  if (!jobNumber) throw new Error('jobNumber required')
  if (!subStatus) throw new Error('subStatus required')
  const jobId = await resolveJobId(jobNumber, trace)

  const pop = await sfFetch('/jobs/showSubStatusPopover', { method: 'POST', xhr: true, body: `jobId=${enc(jobId)}` })
  trace.push({ step: 'popover', status: pop.status, bytes: pop.text.length })
  if (pop.loginRedirect || !pop.text) return { ok: false, error: 'SF session expired — the sub-status popover did not load', trace }
  const options = parseSubStatusOptions(pop.text)
  if (!options.length) return { ok: false, error: 'no sub-statuses found on the popover — SF may have changed the page', trace }
  const id = pickSubStatusId(options, subStatus)
  if (!id) {
    // Naming the alternatives turns "it failed" into "someone renamed it in SF".
    return { ok: false, error: `SF has no sub-status named "${subStatus}" (it offers: ${options.map((o) => o.name).join(', ')})`, trace }
  }

  if (dryRun) {
    trace.push({ step: 'save', skipped: 'dry run' })
    return { ok: true, dryRun: true, jobId, subStatus, subStatusId: id, trace }
  }

  const res = await sfFetch('/jobs/updateJobSubStatus', { method: 'POST', xhr: true, body: `jobId=${enc(jobId)}&jobSubStatus=${enc(id)}` })
  trace.push({ step: 'save', status: res.status, bytes: res.text.length })
  if (res.loginRedirect) return { ok: false, error: 'SF session expired on save', trace }
  const now = subStatusFromResponse(res.text)
  if (!now) return { ok: false, error: `SF answered ${res.status} with no sub-status in the body: ${(res.text || '').slice(0, 200)}`, trace }
  if (nameKey(now.name) !== nameKey(subStatus)) {
    return { ok: false, error: `asked for "${subStatus}" but SF says the job is now "${now.name}"`, trace }
  }
  return { ok: true, jobId, subStatus: now.name, subStatusId: id, color: now.color, trace }
}
