// MAIN-world bridge for Clopay document downloads.
//
// The document PDFs at hdprogram.clopay.com/showdocument/{id}.pdf are only served to
// an authenticated request made from the PAGE ITSELF — a background-worker fetch (no
// session cookie) and even an isolated-world content-script fetch both get a ~15KB
// "not authorized" HTML page instead of the file. A fetch from the page's MAIN world
// (exactly where the working console probe ran) IS authenticated. This script runs in
// that main world (manifest "world": "MAIN") and does the fetch on request from the
// isolated content script, returning the bytes as base64 over window.postMessage.

(() => {
  function abToB64(buf) {
    const bytes = new Uint8Array(buf)
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    return btoa(bin)
  }
  window.addEventListener('message', async (e) => {
    const d = e.data
    if (e.source !== window || !d || d.__clopayFetch !== true || !d.id || !d.url) return
    try {
      const r = await fetch(d.url, { credentials: 'include' })
      const ct = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
      const buf = await r.arrayBuffer()
      window.postMessage({ __clopayFetchResult: true, id: d.id, ok: r.ok, status: r.status, ct, b64: abToB64(buf), size: buf.byteLength }, '*')
    } catch (err) {
      window.postMessage({ __clopayFetchResult: true, id: d.id, ok: false, error: String(err && err.message || err) }, '*')
    }
  })
})()
