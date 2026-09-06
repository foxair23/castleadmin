// Add IPO line items to an existing Service Fusion job.
//
// Service Fusion's REST API cannot modify a job that already exists — PUT /jobs is 405 and no
// update endpoint is documented — so, exactly as the remittance flow does for payments, this
// drives SF's own web session instead. Runs in the extension service worker (no DOM), so the
// returned HTML is parsed with targeted regexes.
//
// Flow, all verified against real captured requests:
//   1. resolveJobId(jobNumber)   — global search → the hashed web id used by /jobs/jobEdit
//   2. GET  /jobs/jobEdit?id=…   — the whole edit form
//   3. parseFormFields(html)     — every field, so the post is the form as it stands
//   4. per code: POST /serviceSpot/loadServicesProductsSearch  → serviceId
//                POST /estimate/estimateGetServiceDetails      → serviceRateId, long name
//   5. append Estimate[Services][…] rows, flip ONLY the charges flags, recompute the total
//   6. POST /jobs/jobEdit?id=…   — 302 → jobView on success
//
// Why re-posting the whole form is safe here: SF gates each section behind its own dirty flag
// (jobLocationModified, jobTechsModified, jobStatusModified …). We set jobChargesModified and
// jobChargesProductsModified to 1 and leave every other flag at 0, so SF applies only the
// charges. `lastUpdated` is echoed back untouched, so a job edited by someone else in the
// meantime is SF's to reject rather than ours to silently overwrite.

const SF = 'https://admin.servicefusion.com'
const enc = (v) => encodeURIComponent(v ?? '')

async function sfFetch(path, { method = 'GET', body, follow = false, xhr = false } = {}) {
  const headers = {}
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded'
  // The search/details endpoints are XHR in the browser; the form save is a navigation.
  // Send each the way SF expects or it bounces to the home page.
  if (xhr) headers['X-Requested-With'] = 'XMLHttpRequest'
  const res = await fetch(`${SF}${path}`, {
    method, credentials: 'include', redirect: follow ? 'follow' : 'manual', headers, body,
  })
  if (follow) {
    const text = await res.text()
    return { status: res.status, url: res.url, redirected: res.redirected, loginRedirect: false, text }
  }
  const loginRedirect = res.type === 'opaqueredirect' || res.status === 0 || (res.status >= 300 && res.status < 400)
  const text = loginRedirect ? '' : await res.text()
  return { status: res.status, url: res.url, redirected: res.redirected, loginRedirect, text }
}

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null
}
const decodeEntities = (s) => (s ?? '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')

/** Every field of the job edit form, in document order.
 *
 *  Scoped to the form that carries `inPage` — the edit page holds other forms (global search
 *  and so on) whose fields would corrupt the post. */
export function parseFormFields(html) {
  const marker = html.search(/name=["']?inPage["']?/i)
  if (marker < 0) throw new Error('job edit form not found (no inPage field) — SF may have redirected to login')
  const start = html.lastIndexOf('<form', marker)
  const endIdx = html.indexOf('</form>', marker)
  const scope = html.slice(start < 0 ? 0 : start, endIdx < 0 ? html.length : endIdx)

  const out = []
  for (const tag of scope.match(/<input\b[^>]*>/gi) ?? []) {
    const name = attr(tag, 'name'); if (!name) continue
    const type = (attr(tag, 'type') || 'text').toLowerCase()
    if (type === 'submit' || type === 'button' || type === 'file' || type === 'image') continue
    // An unchecked box or radio is simply absent from a browser's post.
    if ((type === 'checkbox' || type === 'radio') && !/\bchecked\b/i.test(tag)) continue
    out.push([decodeEntities(name), decodeEntities(attr(tag, 'value') ?? '')])
  }
  for (const block of scope.match(/<textarea\b[^>]*>[\s\S]*?<\/textarea>/gi) ?? []) {
    const name = attr(block.match(/<textarea\b[^>]*>/i)[0], 'name'); if (!name) continue
    const inner = block.replace(/^<textarea\b[^>]*>/i, '').replace(/<\/textarea>$/i, '')
    out.push([decodeEntities(name), decodeEntities(inner)])
  }
  for (const block of scope.match(/<select\b[^>]*>[\s\S]*?<\/select>/gi) ?? []) {
    const name = attr(block.match(/<select\b[^>]*>/i)[0], 'name'); if (!name) continue
    const opts = block.match(/<option\b[^>]*>/gi) ?? []
    const chosen = opts.find(o => /\bselected\b/i.test(o))
    if (!chosen) { out.push([decodeEntities(name), '']); continue }
    const v = attr(chosen, 'value')
    out.push([decodeEntities(name), decodeEntities(v ?? '')])
  }
  return out
}

/** An SF job NUMBER (1020259223) → the hashed web id /jobs/jobEdit wants. */
export async function resolveJobId(jobNumber, trace) {
  const r = await sfFetch('/serviceSpot/loadGlobalSearchResults', { method: 'POST', xhr: true, body: `string=${enc(jobNumber)}` })
  trace.push({ step: 'searchJob', status: r.status })
  if (r.loginRedirect) throw new Error('SF session expired — sign in to admin.servicefusion.com')
  const m = r.text.match(/\/jobs\/job(?:View|Edit)\?id=([A-Za-z0-9_\-]+)/)
  if (!m) throw new Error(`job ${jobNumber} not found in SF global search`)
  return m[1]
}

/** A catalog code (FIR010) → the ids a service row needs. */
export async function lookupService(code, trace) {
  const s = await sfFetch('/serviceSpot/loadServicesProductsSearch', { method: 'POST', xhr: true, body: `string=${enc(code)}` })
  if (s.loginRedirect) throw new Error('SF session expired — sign in to admin.servicefusion.com')
  let found = null
  try {
    const json = JSON.parse(s.text)
    // Exact name match only. A partial search for "FIR10" also returns FIR100 and FIR1010,
    // and posting the wrong service would put the wrong work on the job.
    found = (json.results ?? []).find(r => String(r.name ?? '').trim().toUpperCase() === code.trim().toUpperCase()) ?? null
  } catch { /* fall through to the error below */ }
  if (!found) throw new Error(`no exact catalog match for "${code}"`)

  const d = await sfFetch('/estimate/estimateGetServiceDetails', { method: 'POST', xhr: true, body: `serviceId=${enc(found.id)}` })
  if (d.loginRedirect) throw new Error('SF session expired — sign in to admin.servicefusion.com')
  let details = null
  try { details = (JSON.parse(d.text).serviceDetails ?? [])[0] ?? null } catch { /* handled below */ }
  if (!details) throw new Error(`no service details for "${code}" (serviceId ${found.id})`)

  trace.push({ step: 'lookup', code, serviceId: found.id, rateId: details.id })
  return {
    serviceId: String(found.id),
    serviceRateId: String(details.id),
    rateName: String(details.short_name ?? code),
    longText: String(details.long_name ?? found.description ?? ''),
    catalogRate: Number(details.rate ?? 0),
    qboClassId: details.qbo_class_id ?? null,
  }
}

const money = (n) => Number(n ?? 0).toFixed(2)

/** Build the post body: the form as it stands, plus our rows, with only the charges flags flipped. */
export function buildBody(fields, resolved) {
  // Drop what we are replacing or recomputing; everything else is echoed back untouched.
  const drop = /^(Estimate\[Services\]|Estimate\[total\]|job\w*Modified|Estimate\[qbo_class_id\])/
  const parts = []
  for (const [k, v] of fields) {
    if (drop.test(k)) continue
    parts.push(`${enc(k)}=${enc(v)}`)
  }

  // Only the charges sections are modified. Every other flag stays 0 so SF leaves that
  // section of the job exactly as it found it.
  const flags = {
    jobTableValuesModified: 0, jobContactsModified: 0, jobStartDateModified: 0,
    jobChargesModified: 1, jobChargesProductsModified: 1,
    jobChargesDriveModified: 0, jobChargesExpensesModified: 0, jobDocumentsModified: 0,
    jobTasksModified: 0, jobTechsModified: 0, jobUsersModified: 0, jobLocationModified: 0,
    jobEquipmentsModified: 0, jobNotesModified: 0, jobCustomFieldModified: 0,
    jobJobNotesModified: 0, jobStatusModified: 0,
  }
  for (const [k, v] of Object.entries(flags)) parts.push(`${k}=${v}`)
  parts.push('Estimate[qbo_class_id]=0')

  let total = 0
  resolved.forEach((r, i) => {
    const lineTotal = Number(r.quantity) * Number(r.rate)
    total += lineTotal
    // The bucket index only has to be unique per service — SF's UI uses an arbitrary row
    // counter. We only ever write to a job with no existing services, so nothing can collide.
    const p = `Estimate[Services][${r.serviceId}][${i + 1}]`
    const row = {
      item_index: i + 1, parent_index: 0,
      serviceRateId: r.serviceRateId, serviceId: r.serviceId,
      rateName: r.rateName, longText: r.longText,
      qty: money(r.quantity), unitPrice: money(r.rate), total: money(lineTotal),
      actual_cost: '0.00', cost: '0.00', taxId: 'NON',
      // Empty on a NEW row — a populated pair is what marks a line already saved on the job.
      jobServiceListId: '', jobServiceRateId: '', jobServiceRatePatternRowId: '',
      qbo_class_id: r.qboClassId ?? 0,
    }
    for (const [k, v] of Object.entries(row)) parts.push(`${enc(`${p}[${k}]`)}=${enc(v)}`)
  })
  parts.push(`Estimate[total]=${money(total)}`)
  return { body: parts.join('&'), total }
}

/** Put one order's IPO lines on its SF job. `dryRun` returns the body without posting. */
export async function addLinesToJob({ jobNumber, lines, dryRun = false }) {
  const trace = []
  if (!jobNumber) throw new Error('jobNumber required')
  if (!lines?.length) throw new Error('no lines to add')

  const jobId = await resolveJobId(jobNumber, trace)
  const page = await sfFetch(`/jobs/jobEdit?id=${enc(jobId)}`)
  trace.push({ step: 'openForm', status: page.status, bytes: page.text.length })
  if (page.loginRedirect) throw new Error('SF session expired — sign in to admin.servicefusion.com')

  const fields = parseFormFields(page.text)
  trace.push({ step: 'parseForm', fields: fields.length })

  // Never add to a job that already has charges. This is the guard that keeps us from
  // competing with hand-entered work, and it is checked against the LIVE form, not a mirror.
  const existing = fields.filter(([k]) => /^Estimate\[Services\]\[/.test(k) && /\[serviceId\]$/.test(k))
  if (existing.length > 0) {
    return { ok: false, skipped: true, reason: `job ${jobNumber} already has ${existing.length} service line(s)`, trace }
  }

  const resolved = []
  for (const l of lines) {
    const svc = await lookupService(l.code, trace)
    resolved.push({ ...svc, quantity: l.quantity, rate: l.rate, longText: l.description || svc.longText })
  }

  const { body, total } = buildBody(fields, resolved)
  if (dryRun) return { ok: true, dryRun: true, jobId, posted: 0, total, bodyPreview: body.slice(0, 4000), trace }

  const res = await sfFetch(`/jobs/jobEdit?id=${enc(jobId)}`, { method: 'POST', body, follow: true })
  trace.push({ step: 'save', status: res.status, url: res.url })
  // A successful save redirects to jobView; landing back on jobEdit means SF rejected it.
  const ok = /\/jobs\/jobView/.test(res.url || '')
  if (!ok) throw new Error(`save did not land on jobView (status ${res.status}, url ${res.url || 'n/a'})`)
  return { ok: true, jobId, posted: resolved.length, total, trace }
}
