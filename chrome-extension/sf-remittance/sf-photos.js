// Pull a job's pictures out of Service Fusion's web session.
//
// SF's REST API lists a job's pictures by bare file name and has no file endpoint, so the
// bytes come from the job page in the logged-in browser session, the same way payments,
// line items and appointments go the other way. The app queues jobs; this module opens each
// job view page, finds the picture files, downloads them, shrinks them, and hands them back
// one at a time (one request per picture keeps every call under the server's size limit).
//
// Two layers on purpose:
//   findPictureUrls(html, known)  — pure, unit-tested: every candidate picture URL on the page,
//                                   with the ones matching the API's file names marked.
//   fetchJobPhotos(item)          — the live pass. If nothing on the page matches a known file
//                                   name it still reports what it saw (discovery), so the next
//                                   fix is written from evidence rather than a guess.

import { sfFetch, resolveJobId } from './sf-lines.js'

const SF = 'https://admin.servicefusion.com'
const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif|gif)(\?|$)/i
// Chrome/site chrome we never want: logos, icons, avatars, sprites, spacer gifs.
const JUNK = /logo|icon|sprite|avatar|favicon|spacer|blank\.gif|button|badge|loader|spinner|\/img\/|\/images\/ui|assets\/img/i

/** Strip a file name down to what both sides share: base name without directories, query or size suffixes. */
export function fileKey(s) {
  const base = String(s ?? '').split(/[?#]/)[0].split('/').pop() ?? ''
  return base.toLowerCase().replace(/[-_](thumb|small|medium|large|\d{2,4}x\d{2,4})(?=\.)/, '')
}

/** Every URL on the page that could be a picture, absolute, de-duplicated, known ones flagged. */
export function findPictureUrls(html, known = []) {
  const knownKeys = new Set((known ?? []).map(fileKey).filter(Boolean))
  const seen = new Map()
  const add = (raw, via) => {
    let u = String(raw ?? '').trim().replace(/&amp;/g, '&')
    if (!u || u.startsWith('data:') || u.startsWith('javascript:')) return
    if (u.startsWith('//')) u = `https:${u}`
    else if (u.startsWith('/')) u = `${SF}${u}`
    else if (!/^https?:\/\//i.test(u)) return
    const key = fileKey(u)
    const matched = knownKeys.has(key) || [...knownKeys].some(k => k && u.toLowerCase().includes(k.replace(/\.[a-z0-9]+$/, '')))
    const image = IMAGE_EXT.test(u) || matched
    if (!image || (JUNK.test(u) && !matched)) return
    if (!seen.has(u)) seen.set(u, { url: u, key, matched, via })
    else if (matched) seen.get(u).matched = true
  }
  // SF's job page keeps the pictures in a div#gallery (thumbnail inside a link); scan it first.
  const g = /<div\b[^>]*\bid=["']gallery["'][^>]*>([\s\S]*?)(?=<\/section|<script|$)/i.exec(html)
  if (g) {
    for (const m of g[1].matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/gi)) add(m[1], 'a')
    for (const m of g[1].matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)) add(m[1], 'img')
  }
  for (const m of html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)) add(m[1], 'img')
  for (const m of html.matchAll(/\b(?:data-src|data-original|data-full|data-href|data-url)=["']([^"']+)["']/gi)) add(m[1], 'data')
  for (const m of html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/gi)) add(m[1], 'a')
  for (const m of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(m[1], 'css')
  for (const m of html.matchAll(/["'](https?:\/\/[^"'\s]+|\/[^"'\s]*?)["']/g)) { if (IMAGE_EXT.test(m[1]) || knownKeys.has(fileKey(m[1]))) add(m[1], 'script') }
  // One URL per picture: the full-size file beats its thumbnail (same key, name without a
  // size suffix, or the link around the thumbnail), so we download the real photo once.
  const byKey = new Map()
  const rank = (x) => (fileKey(x.url) === x.key && !/[-_](thumb|small|medium|\d{2,4}x\d{2,4})\./i.test(x.url) ? 2 : 0) + (x.via === 'a' || x.via === 'data' ? 1 : 0)
  for (const x of seen.values()) {
    const cur = byKey.get(x.key)
    if (!cur || rank(x) > rank(cur)) byKey.set(x.key, { ...x, matched: x.matched || !!cur?.matched })
    else if (x.matched) cur.matched = true
  }
  const all = [...byKey.values()]
  return { matched: all.filter(x => x.matched), others: all.filter(x => !x.matched), knownKeys: [...knownKeys] }
}

/** Short evidence about the page for the diagnostics: picture-ish script/XHR paths and section snippets. */
export function describePage(html) {
  const paths = [...new Set([...html.matchAll(/["'](\/[a-z0-9_\-/]*(?:picture|photo|image|document|file|attachment|upload)[a-z0-9_\-/?=&.]*)["']/gi)].map(m => m[1]))].slice(0, 15)
  const snippets = []
  const re = /(?:picture|photo)s?/gi
  let m, n = 0
  while ((m = re.exec(html)) && n < 4) {
    const start = Math.max(0, m.index - 300), end = Math.min(html.length, m.index + 500)
    snippets.push(html.slice(start, end).replace(/\s+/g, ' '))
    re.lastIndex = m.index + 2000 // spread the samples out
    n++
  }
  const iframes = [...html.matchAll(/<iframe\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(x => x[1]).slice(0, 5)
  return { paths, snippets, iframes, bytes: html.length }
}

/** Shrink a picture in the worker (OffscreenCanvas) so each callback stays small. Falls back to the original bytes. */
async function shrink(blob, maxEdge = 1600) {
  try {
    const bmp = await createImageBitmap(blob)
    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height))
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale))
    const canvas = new OffscreenCanvas(w, h)
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h)
    bmp.close?.()
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.86 })
    return { blob: out, contentType: 'image/jpeg', width: w, height: h, shrunk: true }
  } catch {
    return { blob, contentType: blob.type || null, width: null, height: null, shrunk: false }
  }
}

const toBase64 = async (blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** One queued job. `send(payload)` posts a callback; called once per picture and once with `done`. */
export async function fetchJobPhotos({ id, jobNumber, known = [], dryRun = false }, send) {
  const trace = []
  if (!jobNumber) throw new Error('jobNumber required')
  const jobId = await resolveJobId(jobNumber, trace)
  const page = await sfFetch(`/jobs/jobView?id=${encodeURIComponent(jobId)}`, { follow: true })
  if (!page.text || /login/i.test(page.url || '')) return { ok: false, error: 'SF session expired — got the login page', trace }
  const found = findPictureUrls(page.text, known)
  const discovery = { jobId, pageUrl: page.url, known, matched: found.matched.map(x => x.url).slice(0, 30), others: found.others.map(x => x.url).slice(0, 30), page: describePage(page.text) }
  trace.push({ step: 'scan', matched: found.matched.length, others: found.others.length })

  // Prefer the pictures the API told us about; when there are none but the page carries real
  // image files (not site chrome), take those and say so.
  const candidates = found.matched.length ? found.matched : found.others.filter(x => /\/(?:uploads?|files?|attachments?|pictures?|photos?|documents?)\//i.test(x.url) || /amazonaws|cloudfront|blob\.core|googleapis/i.test(x.url))
  if (!candidates.length) {
    if (!dryRun) await send({ id, discovery })
    return { ok: undefined, discovery, trace } // discovery only
  }
  if (dryRun) return { ok: undefined, discovery, wouldFetch: candidates.map(c => c.url), trace }

  await send({ id, discovery })
  let received = 0, failed = 0
  for (const c of candidates.slice(0, 12)) {
    try {
      const res = await fetch(c.url, { credentials: 'include' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      if (blob.size < 2000) throw new Error(`too small (${blob.size} bytes)`)
      const s = await shrink(blob)
      const knownName = (known ?? []).find(k => fileKey(k) === c.key) ?? null
      await send({ id, photo: { name: knownName ?? c.key, sourceRef: knownName ?? c.key, contentType: s.contentType, base64: await toBase64(s.blob) } })
      received++
      trace.push({ step: 'photo', url: c.url.slice(0, 120), bytes: s.blob.size, shrunk: s.shrunk })
    } catch (e) {
      failed++
      trace.push({ step: 'photo', url: c.url.slice(0, 120), error: e instanceof Error ? e.message : String(e) })
    }
    await new Promise(r => setTimeout(r, 400))
  }
  if (received === 0) {
    await send({ id, done: { ok: false, received, error: `all ${failed} picture downloads failed` } })
    return { ok: false, error: 'no picture could be downloaded', discovery, trace }
  }
  await send({ id, done: { ok: true, received } })
  return { ok: true, received, failed, discovery, trace }
}
