// File a signed e-sign form on its Service Fusion job, through the web session.
//
// SF's REST API has no document endpoint at all, so this goes the same way notes, line items
// and appointments do. Captured from a real job on 2026-09-15, so it is written from evidence:
//
//   GET  /jobs/jobView?id=<jobId>            → the page, carrying
//                                              <input type="hidden" id="customer_id" value="…">
//   POST /jobs/loadCustomerDocuments  id=<customerId>
//                                            → <select id='documents-list'> of that CUSTOMER's
//                                              documents, one <option value="<docId>">name</option>
//   POST /jobsFileUpload?id=<customerId>     → multipart { name, file }; the bytes land in the
//                                              customer's library, not yet on the job
//   POST /jobs/saveJobDocumentInfo   parentId=<jobId>&id=&customer_doc_id=<docId>
//                                    &name=<filename>&jobId=<jobId>
//                                            → {"status":"ok", …} — THIS is what puts it on the job
//
// Two things worth knowing about the shape of that:
//   • Documents belong to the CUSTOMER; a job merely links to one. So uploading and attaching
//     are separate steps, and a half-finished attempt leaves an orphan in the library.
//   • We therefore read the library BEFORE uploading. A file already there under our exact
//     name is reused instead of uploaded again, which makes a retry safe rather than a way to
//     litter a customer's record with copies of the same form.
// The upload response is never parsed: we re-read the library and take the row that appeared,
// which is what the page itself does and does not depend on an undocumented body.

import { sfFetch, resolveJobId, enc } from './sf-lines.js'

const grab = (html, re) => { const m = re.exec(html); return m ? (m[1] ?? m[0]) : null }
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }
const decode = (s) => (s ?? '').replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
/** Filenames round-trip through SF and a browser file picker; match on shape, not bytes.
 *  (A macOS filename can carry a narrow no-break space where we wrote a plain one.) */
export const fileKey = (s) => decode(s).replace(/\s+/g, ' ').trim().toLowerCase()

/** The customer this job belongs to — documents hang off the customer, not the job. */
export function customerIdFromJobPage(html) {
  return grab(html ?? '', /<input[^>]*\bid=["']?customer_id["']?[^>]*\bvalue=["']([^"']+)["']/i)
    ?? grab(html ?? '', /\bdata-customer-id=["']([^"']+)["']/i)
    ?? grab(html ?? '', /\/customer\/editCustomer\?id=([A-Za-z0-9_-]+)/)
}

/** The customer's document library: [{ id, name }]. Pure, for tests. */
export function parseCustomerDocuments(html) {
  const text = html ?? ''
  let scope = text
  const open = /<select\b[^>]*\bid=["']?documents-list["']?[^>]*>/i.exec(text)
  if (open) {
    const from = open.index + open[0].length
    const close = text.indexOf('</select>', from)
    scope = close < 0 ? text.slice(from) : text.slice(from, close)
  }
  const out = []
  for (const m of scope.matchAll(/<option\b[^>]*\bvalue=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/option>/gi)) {
    const id = m[1]
    if (!/^\d+$/.test(id)) continue                       // skips the "Select existing document" placeholder
    const name = decode(m[2].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
    if (name) out.push({ id, name })
  }
  return out
}

/** The document we just put there: the one that appeared since `before` and carries our name.
 *  Falls back to a name match, newest id first, when the before/after diff is inconclusive. */
export function findUploadedDocId(before, after, filename) {
  const want = fileKey(filename)
  const had = new Set((before ?? []).map((d) => d.id))
  const fresh = (after ?? []).filter((d) => !had.has(d.id))
  const byName = fresh.filter((d) => fileKey(d.name) === want)
  if (byName.length) return byName[byName.length - 1].id
  if (fresh.length === 1) return fresh[0].id
  const any = (after ?? []).filter((d) => fileKey(d.name) === want)
  return any.length ? any[any.length - 1].id : null
}

/** SF confirming the document is now on the job. */
export function attachSucceeded(text) {
  try {
    const j = JSON.parse(text)
    return j?.status === 'ok' ? { ok: true, jobDocId: j?.documentData?.jobDocId ?? null } : { ok: false, error: `SF said: ${String(text).slice(0, 200)}` }
  } catch { return { ok: false, error: `SF answered with no JSON: ${String(text).slice(0, 200)}` } }
}

async function customerDocuments(customerId, trace, step) {
  const res = await sfFetch('/jobs/loadCustomerDocuments', { method: 'POST', xhr: true, body: `id=${enc(customerId)}` })
  trace.push({ step, status: res.status, bytes: res.text.length })
  if (res.loginRedirect) throw new Error('SF session expired — the document list did not load')
  return parseCustomerDocuments(res.text)
}

/** Upload one file and attach it to the job. */
export async function uploadDocument({ jobNumber, filename, downloadUrl, dryRun = false }) {
  const trace = []
  if (!jobNumber) throw new Error('jobNumber required')
  if (!filename) throw new Error('filename required')
  const jobId = await resolveJobId(jobNumber, trace)

  const page = await sfFetch(`/jobs/jobView?id=${enc(jobId)}`, { follow: true })
  trace.push({ step: 'jobView', status: page.status, bytes: page.text.length })
  if (!page.text || /login/i.test(page.url || '')) return { ok: false, error: 'SF session expired — got the login page', trace }
  const customerId = customerIdFromJobPage(page.text)
  if (!customerId) return { ok: false, error: 'could not find the customer on the job page — SF may have changed it', trace }

  const before = await customerDocuments(customerId, trace, 'documentsBefore')
  // Already in the library under our name: a previous attempt uploaded but did not attach.
  let docId = before.filter((d) => fileKey(d.name) === fileKey(filename)).map((d) => d.id).pop() ?? null
  const reused = !!docId

  if (dryRun) {
    trace.push({ step: 'upload', skipped: 'dry run' })
    return { ok: true, dryRun: true, jobId, customerId, filename, reused, trace }
  }

  if (!docId) {
    if (!downloadUrl) return { ok: false, error: 'no downloadUrl for the file', trace }
    const file = await fetch(downloadUrl)
    if (!file.ok) return { ok: false, error: `could not fetch the file to upload (${file.status})`, trace }
    const blob = await file.blob()
    trace.push({ step: 'fetchFile', bytes: blob.size })
    const form = new FormData()
    form.append('name', filename)
    form.append('file', blob, filename)
    const up = await sfFetch(`/jobsFileUpload?id=${enc(customerId)}`, { method: 'POST', body: form })
    trace.push({ step: 'upload', status: up.status, bytes: up.text.length })
    if (up.loginRedirect) return { ok: false, error: 'SF session expired during the upload', trace }
    const after = await customerDocuments(customerId, trace, 'documentsAfter')
    docId = findUploadedDocId(before, after, filename)
    if (!docId) return { ok: false, error: `the upload returned ${up.status} but "${filename}" is not in the customer's documents`, trace }
  }

  const body = `parentId=${enc(jobId)}&id=&customer_doc_id=${enc(docId)}&name=${enc(filename)}&jobId=${enc(jobId)}`
  const res = await sfFetch('/jobs/saveJobDocumentInfo', { method: 'POST', xhr: true, body })
  trace.push({ step: 'attach', status: res.status, bytes: res.text.length })
  if (res.loginRedirect) return { ok: false, error: 'SF session expired before the document reached the job', trace }
  const done = attachSucceeded(res.text)
  if (!done.ok) return { ok: false, error: done.error, trace, sfResponse: res.text.slice(0, 500) }
  return { ok: true, jobId, customerId, docId, jobDocId: done.jobDocId, reused, trace }
}
