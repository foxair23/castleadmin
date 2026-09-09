// Upload a file onto an existing Service Fusion job — DISCOVERY pass.
//
// SF's REST API has no document endpoint at all, so signed e-sign forms must go up through
// the web session like everything else the extension writes. The exact request the job
// page's upload widget makes has NOT been captured yet. Until it is, this module does not
// upload anything: it opens the job view page, records how the upload widget is configured
// (its URL, extra form fields, the file field's name, chunking, any CSRF token) and reports
// that back to Castle Admin, where the real request can then be written from evidence rather
// than a guess. Every item stays queued; the office gets the PDF from Action Items meanwhile.
//
// Once captured, `uploadDocument` grows a real multipart POST (FormData + Blob,
// credentials: 'include') and the dry run shows the planned request.

import { sfFetch, resolveJobId } from './sf-lines.js'

const grab = (html, re) => { const m = re.exec(html); return m ? (m[1] ?? m[0]) : null }

/** What the job page says about uploading. Pure, so it can be unit-tested on saved HTML. */
export function discoverUploadConfig(html) {
  const out = { pluploadUrl: null, fileDataName: null, chunkSize: null, multipartParams: null, forms: [], csrf: null, snippets: [] }
  // plupload's init block: url, file_data_name, chunk_size, multipart_params
  const pl = /new\s+plupload\.Uploader\s*\(\s*\{([\s\S]{0,4000}?)\}\s*\)/.exec(html)
  if (pl) {
    const block = pl[1]
    out.pluploadUrl = grab(block, /\burl\s*:\s*['"]([^'"]+)['"]/)
    out.fileDataName = grab(block, /file_data_name\s*:\s*['"]([^'"]+)['"]/)
    out.chunkSize = grab(block, /chunk_size\s*:\s*['"]?([^,'"\s]+)/)
    out.multipartParams = grab(block, /multipart_params\s*:\s*(\{[^}]*\})/)
    out.snippets.push(block.slice(0, 1500))
  }
  // Any form that carries a file input: action, method, the file field and hidden fields.
  const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi
  let m
  while ((m = formRe.exec(html))) {
    if (!/<input[^>]+type=["']?file/i.test(m[2])) continue
    const attrs = m[1]
    const hidden = [...m[2].matchAll(/<input[^>]+type=["']?hidden["']?[^>]*>/gi)].map(h => ({ name: grab(h[0], /name=["']?([^"'\s>]+)/), value: grab(h[0], /value=["']?([^"'>]*)/) }))
    out.forms.push({
      action: grab(attrs, /action=["']?([^"'\s>]+)/), method: grab(attrs, /method=["']?([^"'\s>]+)/), enctype: grab(attrs, /enctype=["']?([^"'\s>]+)/),
      fileField: grab(m[2], /<input[^>]+type=["']?file["']?[^>]*name=["']?([^"'\s>]+)/i) ?? grab(m[2], /<input[^>]+name=["']?([^"'\s>]+)["']?[^>]*type=["']?file/i),
      hidden,
    })
  }
  out.csrf = grab(html, /name=["']?(?:_csrf|csrf_token|YII_CSRF_TOKEN|_token)["']?[^>]*value=["']?([^"'>]+)/i) ?? grab(html, /<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)/i)
  // Script URLs that look like the upload/attachment handler, for the capture step.
  out.snippets.push(...[...html.matchAll(/["'](\/jobs\/[^"']*(?:upload|attach|document|file)[^"']*)["']/gi)].map(x => x[1]).slice(0, 10))
  return out
}

/** Discovery for one queued item: find the job, read its page, report the config. */
export async function uploadDocument({ jobNumber, dryRun = false }) {
  const trace = []
  if (!jobNumber) throw new Error('jobNumber required')
  const jobId = await resolveJobId(jobNumber, trace)
  const page = await sfFetch(`/jobs/jobView?id=${encodeURIComponent(jobId)}`, { follow: true })
  if (!page.text || /login/i.test(page.url || '')) return { ok: false, error: 'SF session expired — got the login page', trace }
  const discovery = { jobId, pageUrl: page.url, ...discoverUploadConfig(page.text) }
  // No upload request is known yet: this is always discovery, dry run or live.
  return { ok: undefined, discovery, dryRun, trace }
}
