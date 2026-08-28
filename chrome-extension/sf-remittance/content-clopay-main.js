// MAIN-world bridge for Clopay document downloads.
//
// A document PDF is only obtainable by the PROVEN sequence, run from the page's MAIN
// world (where the session cookie + bearer are usable):
//   1) GET prod-apigateway…/installerdocuments/getdocumenturl?documentId=…&installerNum=…
//      &isChubOrder=N&documentType=<the doc's documenT_TYPE>  (Bearer)  — this GENERATES
//      the PDF server-side (~5s) and returns the hdprogram.clopay.com/showdocument URL.
//   2) fetch(that URL, { credentials:'include' })  — returns the real application/pdf bytes.
// A background-worker or isolated-content-script fetch, or a fetch with the wrong/absent
// documentType, gets a ~15KB "not authorized" HTML page instead. This script runs in the
// main world (manifest "world":"MAIN") and performs both steps on request from the
// isolated content script, returning the bytes as base64 over window.postMessage.

(() => {
  const API = 'https://prod-apigateway.clopay.com/api/hdprogram/v1'
  function abToB64(buf) {
    const bytes = new Uint8Array(buf)
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    return btoa(bin)
  }
  window.addEventListener('message', async (e) => {
    const d = e.data
    if (e.source !== window || !d || d.__clopayFetch !== true || !d.id || d.documentId == null) return
    const reply = (o) => window.postMessage({ __clopayFetchResult: true, id: d.id, ...o }, '*')
    try {
      const token = localStorage.getItem('bearerToken')
      // 1) resolve (+ generate) the document URL for this doc's type.
      const gurl = `${API}/installerdocuments/getdocumenturl?documentId=${encodeURIComponent(d.documentId)}`
        + `&installerNum=${encodeURIComponent(d.installerNum || '56505')}&isChubOrder=N`
        + `&documentType=${encodeURIComponent(d.documentType || '')}`
      const gr = await fetch(gurl, { headers: { authorization: 'Bearer ' + token, accept: 'application/json' } })
      let gj = null; try { gj = await gr.json() } catch { /* non-json */ }
      const url = gj && gj.responseObject
      if (!url || typeof url !== 'string') { reply({ ok: false, error: `getdocumenturl ${gr.status}` }); return }
      // 2) fetch the actual file (session cookie).
      const r = await fetch(url, { credentials: 'include' })
      const ct = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
      const buf = await r.arrayBuffer()
      reply({ ok: r.ok, status: r.status, ct, size: buf.byteLength, b64: abToB64(buf), url })
    } catch (err) {
      reply({ ok: false, error: String(err && err.message || err) })
    }
  })
})()
