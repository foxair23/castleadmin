// Content script — Clopay HD Program installer portal at hdprogram.clopay.com.
// Runs inside the logged-in portal tab and pulls orders + detail from the portal's
// OWN JSON API (prod-apigateway.clopay.com), then sends them to the extension
// background, which forwards them to Castle Admin's /api/vendor-orders/ingest under
// vendor 'clopay_hd'.
//
// WHY the API (not DOM scraping): the orders app is a fragile Angular SPA with no
// per-order URL — clicking a row lazy-loads a detail module that, after the first
// navigation, wedges and serves the previously-loaded order's cached page for every
// subsequent click (observed: every order opened the same customer). Driving that UI
// is hopeless. Instead we read the bearer token the app already holds in localStorage
// and replay the same API calls the app makes — no clicking, no DOM, no stale pages.
//
// The content script still handles reaching a logged-in session: on cca.clopay.com it
// clicks the "HD Program" tile (or navigates) to hdprogram.clopay.com; content-login.js
// re-auths on any login page. Once on hdprogram with a token present, it runs the API
// crawl and reports done.
//
// API (base https://prod-apigateway.clopay.com/api/hdprogram/v1, Bearer token, all
// responses wrapped { message, responseObject, statusCode }):
//   LIST     POST /installerorder/orders        {installernum}
//   SUMMARY  POST /installerorder/details       {installerNum, incidentId}      → milestones
//   STATUS   POST /installerorder/orderdetails  {installerNum, incidentId}      → payment/shipment/forms
//   FLAGS    POST /installerorder/orderstatusinfo {installerNum}                → per-order notes-available flag
//   NOTES    GET  /notes/{installerNum}/{header_id}/{username}                  → notesList
//   DOCS     GET  /installerdocuments/{installerNum}/{incidentId}/{poNumber}    → documents

(() => {
  const VENDOR = 'clopay_hd'
  const NAME = 'clopay'            // message-type prefix ('clopay-crawl-done', …) + log tag
  const API_BASE = 'https://prod-apigateway.clopay.com/api/hdprogram/v1'
  const LIST_URL = 'https://hdprogram.clopay.com/orders'
  const DEFAULT_INSTALLER = '56505' // Castle Garage's dealer/installer number (configurable)
  const LOG = (...a) => console.log(`[${NAME}]`, ...a)
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()

  // 'MM/DD/YYYY[ …]' → 'YYYY-MM-DD' (ISO date), else null.
  function toISO(s) {
    const m = norm(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)
    if (!m) return null
    let [, mo, d, y] = m
    if (y.length === 2) y = `20${y}`
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }

  // ── DOM helpers (only for reaching hdprogram from the cca dashboard) ─────────
  function realClick(el) {
    for (const type of ['mousedown', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
    }
  }
  function clickEl(el) {
    if (!el) return false
    try { el.scrollIntoView({ block: 'center', inline: 'center' }) } catch { /* ignore */ }
    const r = el.getBoundingClientRect()
    const cx = Math.max(1, Math.min(window.innerWidth - 1, r.left + r.width / 2))
    const cy = Math.max(1, Math.min(window.innerHeight - 1, r.top + r.height / 2))
    const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 }
    const fromPt = document.elementFromPoint(cx, cy)
    const targets = fromPt && fromPt !== el ? [el, fromPt] : [el]
    for (const t of targets) {
      for (const type of ['pointerover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        try {
          const Ctor = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent
          t.dispatchEvent(new Ctor(type, opts))
        } catch { try { t.dispatchEvent(new MouseEvent('click', opts)) } catch { /* ignore */ } }
      }
    }
    try { el.focus() } catch { /* ignore */ }
    try { el.click() } catch { /* ignore */ }
    return true
  }
  const visible = (el) => {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  function allElements(root) {
    const out = []
    const stack = [root || document]
    while (stack.length) {
      const node = stack.pop()
      let els
      try { els = node.querySelectorAll('*') } catch { continue }
      for (const el of els) { out.push(el); if (el.shadowRoot) stack.push(el.shadowRoot) }
    }
    return out
  }
  function deepQueryAll(selector) {
    return allElements(document).filter(el => { try { return el.matches(selector) } catch { return false } })
  }

  // ── Extension plumbing ──────────────────────────────────────────────────────
  function ctxAlive() { try { return !!(chrome.runtime && chrome.runtime.id) } catch { return false } }
  function storageGet(defaults) {
    return new Promise(resolve => {
      if (!ctxAlive()) { resolve(defaults); return }
      try { chrome.storage.local.get(defaults, (d) => resolve(chrome.runtime.lastError ? defaults : d)) } catch { resolve(defaults) }
    })
  }
  const getCrawlMode = () => storageGet({ clopayCrawlMode: null }).then(d => d.clopayCrawlMode)
  const getCfg = () => storageGet({ clopayInstallerNum: DEFAULT_INSTALLER, clopayMaxDetailPerRun: 12, clopayStoreDocs: true })
  function endCrawl() {
    if (!ctxAlive()) return
    try { chrome.storage.local.remove('clopayCrawlMode') } catch { /* ignore */ }
    try { chrome.runtime.sendMessage({ type: `${NAME}-crawl-done` }) } catch { /* SW asleep — timeout alarm covers it */ }
  }
  function isCrawlTab() {
    return new Promise(resolve => {
      if (!ctxAlive()) { resolve(false); return }
      try { chrome.runtime.sendMessage({ type: `${NAME}-crawl-tab?` }, (resp) => resolve(!chrome.runtime.lastError && !!(resp && resp.isCrawlTab))) }
      catch { resolve(false) }
    })
  }
  /** Post orders to the background → Castle Admin ingest. Resolves with the ingest
   *  result (incl. needDetail), or null on error. */
  async function ingest(kind, payload) {
    if (!ctxAlive()) { LOG('extension link is gone — reload this tab (F5) to re-enable'); return null }
    const mode = (await getCrawlMode()) || 'manual'
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: NAME, kind, mode, vendor: VENDOR, payload }, (res) => {
          if (chrome.runtime.lastError) { LOG('send error', chrome.runtime.lastError.message); resolve(null); return }
          resolve(res)
        })
      } catch (e) { LOG('ingest send failed', e?.message || e); resolve(null) }
    })
  }

  // ── Auth + API ──────────────────────────────────────────────────────────────
  // The Angular app stores its OIDC bearer token in localStorage on this origin;
  // the content script shares the page's localStorage, so we read it directly.
  function readToken() {
    try {
      return localStorage.getItem('bearerToken')
        || sessionStorage.getItem('AccessToken')
        || sessionStorage.getItem('AuthToken')
        || null
    } catch { return null }
  }
  // The notes endpoint is keyed by the logged-in username (e.g. "JohnFox"). It lives
  // in the app's stored user object; scan storage for a plausible field.
  function readUsername() {
    const tryParse = (raw) => { try { return JSON.parse(raw) } catch { return null } }
    for (const store of [sessionStorage, localStorage]) {
      for (const k of ['user', 'User', 'userInfo', 'vendor', 'profile']) {
        let v
        try { v = store.getItem(k) } catch { continue }
        if (!v) continue
        const o = tryParse(v)
        const cand = o && (o.userName || o.username || o.userId || o.vendorName || o.vendorname || o.name || o.login || o.preferred_username)
        if (cand && /^[A-Za-z0-9._@-]{2,60}$/.test(String(cand))) return String(cand)
        if (/^[A-Za-z0-9._@-]{2,60}$/.test(String(v))) return String(v) // a bare string value
      }
    }
    return null
  }

  // Route API calls through the background service worker: it holds host_permissions
  // for *.clopay.com and so bypasses CORS for the cross-origin prod-apigateway host
  // (a content-script fetch would be at the mercy of the API's CORS policy). We read
  // the token here (page localStorage) and pass it along.
  async function apiCall(method, path, body) {
    const token = readToken()
    if (!token) return { status: 0, obj: null, noToken: true }
    if (!ctxAlive()) return { status: -1, obj: null }
    const url = API_BASE + path
    const resp = await new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: `${NAME}-api`, method, url, body: body || null, token }, (r) => {
          resolve(chrome.runtime.lastError ? { status: -1, error: chrome.runtime.lastError.message } : r)
        })
      } catch (e) { resolve({ status: -1, error: String(e) }) }
    })
    if (!resp) return { status: -1, obj: null }
    if (resp.error) LOG('api error', path, resp.status, resp.error)
    const json = resp.json
    return { status: resp.status, obj: json && ('responseObject' in json) ? json.responseObject : json, raw: json }
  }
  const apiPost = (path, body) => apiCall('POST', path, body)
  const apiGet = (path) => apiCall('GET', path, null)

  // ── Mappers: portal JSON → Castle order shape ───────────────────────────────
  const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s && s !== '-' ? s : null }

  // One LIST item → the list-level order object. external_id is the STABLE HD order
  // number (order_number) — NOT the PO, which can change on a change order. The PO
  // goes to customer_po. incident_id / header_id are stashed in raw for the detail
  // fetch.
  function mapListItem(o) {
    if (!o) return null
    const external_id = clean(o.order_number) || clean(o.incident_number) || clean(o.incident_id)
    if (!external_id) return null
    const street = clean(o.address1)
    const street2 = clean(o.address2)
    return {
      external_id,
      customer_po: clean(o.cust_po_number),
      status: clean(o.current_status),
      next_step: clean(o.name),
      order_type: clean(o.incident_type),
      store_number: clean(o.store_number),
      order_date: o.poDate ? toISO(o.poDate) : (o.pO_DATE ? toISO(o.pO_DATE) : null),
      customer_name: clean(o.customer_name),
      street_address: street && street2 ? `${street} ${street2}` : (street || street2),
      city: clean(o.city),
      state_prov: clean(o.state),
      postal_code: clean(o.zip),
      phone: clean(o.primarY_PHONE_NUMBER),
      email: clean(o.email_address),
      raw: {
        incident_id: o.incident_id ?? null,
        header_id: o.header_id ?? null,
        incident_number: clean(o.incident_number),
        status_date: clean(o.current_status_date),
        vip: o.iS_VIP_ORDER === 'Y',
        lead_doc_available: o.iS_LEAD_DOC_AVBL === 'Y',
        multi_order: o.iS_MULTI_ORDER === 'Y',
      },
    }
  }

  // Summary milestones (POST /installerorder/details).
  function mapSummary(arr) {
    if (!Array.isArray(arr)) return { summary: [], text: '' }
    const summary = arr.map(m => {
      const label = clean(m.tasK_NAME) || clean(m.name) || ''
      const posted = clean(m.posteD_DATE)
      const scheduled = clean(m.scheduleD_DATE)
      const completed = clean(m.completeD_DATE)
      return {
        label,
        date: completed || posted || scheduled || null,
        done: !!completed && !/not applicable/i.test(completed),
        posted, scheduled, completed,
        posted_title: clean(m.posteD_DATE_TITLE),
        scheduled_title: clean(m.scheduleD_DATE_TITLE),
        completed_title: clean(m.completeD_DATE_TITLE),
      }
    }).filter(m => m.label)
    const text = summary.map(m => `${m.label}${m.date ? ' — ' + m.date : ''}`).join('\n')
    return { summary, text }
  }
  // Documents (GET /installerdocuments/{inst}/{incident}/{po}). To download a doc you
  // must call getdocumenturl with its `documenT_TYPE` (which GENERATES the PDF, ~5s) and
  // fetch the URL it returns — the raw `url`/showdocument URL is otherwise unauthorized.
  // So we keep the documentId + type; the href is a best-effort display fallback only.
  function mapDocuments(arr) {
    if (!Array.isArray(arr)) return []
    return arr.map(d => {
      const id = d.documenT_ID != null ? String(d.documenT_ID).replace(/\.0$/, '') : null
      return {
        name: clean(d.filE_NAME) || clean(d.documenT_DESC) || (id ? `Document ${id}` : 'Document'),
        id,
        docType: clean(d.documenT_TYPE),
        href: id ? `https://hdprogram.clopay.com/showdocument/${id}.pdf` : clean(d.url),
        date: clean(d.creation_date),
        category: d.categorY_ID != null ? String(d.categorY_ID).replace(/\.0$/, '') : null,
      }
    }).filter(d => d.id || d.href)
  }
  // Notes (GET /notes/{inst}/{header}/{user} → responseObject.notesList).
  function mapNotes(obj) {
    const list = obj && Array.isArray(obj.notesList) ? obj.notesList : (Array.isArray(obj) ? obj : [])
    return list.map(n => ({
      text: clean(n.notes) || clean(n.noteText) || '',
      timestamp: clean(n.creation_date) || clean(n.last_update_date),
      id: n.jtf_note_id != null ? String(n.jtf_note_id).replace(/\.0$/, '') : null,
    })).filter(n => n.text)
  }

  // Fetch + assemble one order's full detail. Returns a detail order object (hasDetail)
  // keyed by the SAME external_id as the list item, or null on failure.
  async function fetchDetail(item, installerNum, username, notesAvail) {
    const inc = item.raw && item.raw.incident_id
    const hdr = item.raw && item.raw.header_id
    const po = item.customer_po
    if (inc == null) { LOG(`detail #${item.external_id}: no incident_id — skipping`); return null }

    const [summaryR, statusR, docsR] = await Promise.all([
      apiPost('/installerorder/details', { installerNum: String(installerNum), incidentId: inc }),
      apiPost('/installerorder/orderdetails', { installerNum: String(installerNum), incidentId: inc }),
      po ? apiGet(`/installerdocuments/${installerNum}/${inc}/${encodeURIComponent(po)}`) : Promise.resolve({ obj: [] }),
    ])
    const { summary, text } = mapSummary(summaryR.obj)
    const documents = mapDocuments(docsR.obj)

    // Notes: keyed by installerNum + header_id. The trailing {username} path segment
    // is IGNORED by the server (verified — any value returns the same notes), so we
    // pass a constant. Skip only when the flags call says this order has none.
    let notes = []
    if (hdr != null && notesAvail !== false) {
      const notesR = await apiGet(`/notes/${installerNum}/${hdr}/${encodeURIComponent(username || 'crawler')}`)
      notes = mapNotes(notesR.obj)
    }

    const statusDetail = statusR.obj && typeof statusR.obj === 'object' && !Array.isArray(statusR.obj) ? statusR.obj : null
    const raw = { ...(item.raw || {}), summary, summary_text: text, documents, notes }
    if (statusDetail) raw.status_detail = statusDetail
    // Keep contact fields on the detail payload too (harmless; server merges).
    return {
      external_id: item.external_id, hasDetail: true,
      order_type: item.order_type, customer_name: item.customer_name,
      phone: item.phone, email: item.email,
      street_address: item.street_address, city: item.city, state_prov: item.state_prov, postal_code: item.postal_code,
      raw,
    }
  }

  // Message the background worker and await its reply.
  function msgBg(payload) {
    return new Promise(resolve => {
      if (!ctxAlive()) { resolve({ ok: false }); return }
      try {
        chrome.runtime.sendMessage(payload, (r) => resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : (r || { ok: false })))
      } catch (e) { resolve({ ok: false, error: String(e) }) }
    })
  }
  // Resolve a document's fetchable URL via getdocumenturl — called DIRECTLY from this
  // page's context, NOT the background proxy. This is not just a URL formatter: it
  // GENERATES the PDF server-side (~5–9s) AND grants THIS browser session access to the
  // document. The grant is only honored when the call comes from the portal page itself
  // (page origin) — a background-worker call returns the same URL but the subsequent
  // navigation still gets the HTML shell (proven across v0.8.0–0.8.5: generated docs
  // never stored via the proxy path, while the identical page-context sequence loaded a
  // real PDF in the console probe). The app's own CORS covers this origin.
  async function resolveDocUrl(documentId, docType, installerNum) {
    const token = readToken()
    if (!token) return null
    const url = `${API_BASE}/installerdocuments/getdocumenturl?documentId=${encodeURIComponent(documentId)}`
      + `&installerNum=${encodeURIComponent(installerNum)}&isChubOrder=N`
      + `&documentType=${encodeURIComponent(docType || '')}`
    try {
      const r = await fetch(url, { headers: { authorization: 'Bearer ' + token, accept: 'application/json' } })
      let j = null; try { j = await r.json() } catch { /* non-json */ }
      const u = j && j.responseObject
      if (!(typeof u === 'string' && u)) { LOG(`getdocumenturl ${documentId}: status ${r.status}, no url`); return null }
      return u
    } catch (e) { LOG(`getdocumenturl ${documentId} failed: ${e?.message || e}`); return null }
  }
  // Download + store one order's documents on Castle's server. Dedup pre-check each doc
  // (skip ones already stored → resumable), then PER DOC: resolve+generate its URL
  // (getdocumenturl) and IMMEDIATELY capture it via `clopay-capture-docs` (the background
  // injects a hidden iframe into THIS authenticated tab — the only context /showdocument
  // serves the real file to). Resolve-then-capture must be interleaved one doc at a time:
  // getdocumenturl is a GRANT that only holds for the most recently requested document —
  // batching all resolves first left only the LAST doc capturable (proven live: exactly one
  // stored per order, always the last). `budget` caps un-stored docs attempted this call.
  async function storeDocuments(detail, installerNum, budget) {
    const docs = (detail && detail.raw && detail.raw.documents) || []
    const external_id = detail.external_id
    let existing = 0, stored = 0, failed = 0, attempted = 0
    for (const d of docs) {
      if (!d.id) continue
      if (attempted >= (budget || docs.length)) break
      const filename = d.name || `doc-${d.id}`
      const chk = await msgBg({ type: 'clopay-store-doc', external_id, documentId: d.id, filename })
      if (chk.ok && chk.alreadyStored) { existing++; continue }
      if (!chk.ok) { LOG(`doc ${d.id}: check failed (${chk.error || '?'})`); continue }
      const url = await resolveDocUrl(d.id, d.docType, installerNum)
      if (!url) { LOG(`doc ${d.id}: getdocumenturl failed`); continue }
      attempted++
      const capture = async (u) => {
        const res = await msgBg({ type: 'clopay-capture-docs', docs: [{ external_id, documentId: d.id, filename, url: u }] })
        return (res && res.results && res.results[0]) || { ok: false, error: res && res.error }
      }
      let r = await capture(url)
      if (!(r.stored || r.alreadyStored)) {
        // One retry with a FRESH grant — live runs showed isolated transient misses
        // (server timing, a service-worker restart) while sibling docs stored fine.
        const url2 = await resolveDocUrl(d.id, d.docType, installerNum)
        if (url2) r = await capture(url2)
      }
      if (r.stored || r.alreadyStored) stored++
      else { failed++; if (r.error) LOG(`doc ${d.id} capture failed: ${r.error}`) }
    }
    if (stored || failed || existing) LOG(`docs #${external_id}: ${stored} stored, ${existing} existing, ${failed} failed`)
    return { stored, existing, failed, attempted }
  }

  // ── Document sync (separate slow job — mode 'docs') ──────────────────────────
  // Decoupled from the fast list/summary/notes crawl. Lists orders (API), then per order
  // fetches its documents and captures each PDF via a hidden iframe the background injects
  // into THIS authenticated tab. Resumable: the dedup pre-check skips docs we already have,
  // and a per-run cap bounds each run — re-run (or the nightly job) picks up where it left off.
  let syncing = false
  async function docsync() {
    if (syncing) { LOG('doc sync already running'); return }
    if (!readToken()) { LOG('doc sync: no token yet — waiting'); return }
    syncing = true
    try {
      const cfg = await getCfg()
      const installerNum = clean(cfg.clopayInstallerNum) || DEFAULT_INSTALLER
      const maxDocs = cfg.clopayMaxDocsPerRun || 300
      LOG(`doc sync start (installer ${installerNum}, cap ${maxDocs} docs)`)
      const listR = await apiPost('/installerorder/orders', { installernum: String(installerNum) })
      if (listR.noToken || listR.status === 401) { LOG('doc sync: token missing/expired — aborting'); return }
      const orders = (Array.isArray(listR.obj) ? listR.obj : []).map(mapListItem).filter(Boolean)
      LOG(`doc sync: ${orders.length} order(s)`)
      let budget = maxDocs, tStored = 0, tExisting = 0, tFailed = 0
      for (const item of orders) {
        if (budget <= 0) { LOG(`doc sync: hit per-run cap (${maxDocs}) — re-run to continue`); break }
        if (!readToken() || !ctxAlive()) { LOG('doc sync: token/context lost — stopping'); break }
        const inc = item.raw && item.raw.incident_id
        const po = item.customer_po
        if (inc == null || !po) continue
        const docsR = await apiGet(`/installerdocuments/${installerNum}/${inc}/${encodeURIComponent(po)}`)
        const documents = mapDocuments(docsR.obj)
        if (!documents.length) continue
        const r = await storeDocuments({ external_id: item.external_id, raw: { documents } }, installerNum, budget)
        budget -= (r.attempted || 0)
        tStored += r.stored; tExisting += r.existing; tFailed += r.failed
        await sleep(200)
      }
      LOG(`doc sync complete — ${tStored} stored, ${tExisting} existing, ${tFailed} failed`)
    } catch (e) {
      LOG('doc sync error', e?.message || e)
    } finally {
      syncing = false
      endCrawl() // signals done → background detaches the debugger + closes the orders tab
    }
  }

  // ── Crawl ────────────────────────────────────────────────────────────────────
  let crawling = false
  async function crawl() {
    if (crawling) { LOG('crawl already running'); return }
    if (!readToken()) { LOG('no bearer token yet — waiting for the app to authenticate'); return }
    crawling = true
    try {
      const cfg = await getCfg()
      const installerNum = clean(cfg.clopayInstallerNum) || DEFAULT_INSTALLER
      const mode = await getCrawlMode()
      const cap = mode === 'full' ? 400 : mode === 'incremental' ? 60 : (cfg.clopayMaxDetailPerRun || 12)
      const username = readUsername() || 'crawler' // server ignores this segment; any value works
      LOG(`crawl start (installer ${installerNum}, mode ${mode || 'manual'})`)

      // 1) LIST
      const listR = await apiPost('/installerorder/orders', { installernum: String(installerNum) })
      if (listR.noToken) { LOG('token missing during list — aborting'); return }
      if (listR.status === 401) { LOG('list 401 — token expired; aborting (next crawl gets a fresh one)'); return }
      const rawList = Array.isArray(listR.obj) ? listR.obj : []
      const orders = rawList.map(mapListItem).filter(Boolean)
      LOG(`list: ${orders.length} order(s) (status ${listR.status})`)
      if (!orders.length) { LOG('list empty — DOM/API may have changed; aborting'); return }
      const res = await ingest('list', orders)
      LOG('ingest(list) →', res && { inserted: res.inserted, updated: res.updated, needDetail: (res.needDetail || []).length })

      // 2) DETAIL. A FULL crawl re-details EVERY order (refreshes notes/documents/
      // status for all — the manual "crawl now" + the nightly backfill); incremental
      // details only the orders the server flags as needing it (new orders + ones whose
      // status just changed). Capped/paced either way.
      const need = new Set((res && res.needDetail) || [])
      const byId = new Map(orders.map(o => [o.external_id, o]))
      const allIds = orders.map(o => o.external_id)
      const targets = (mode === 'full' ? allIds : allIds.filter(id => need.has(id))).slice(0, cap)
      LOG(`detail: ${targets.length} ${mode === 'full' ? '(full — all orders)' : `of ${need.size} needing detail`} (cap ${cap})`)

      // Per-order notes-available flags (one list-level call). Keyed by incident_id.
      const notesAvail = new Map()
      try {
        const flagsR = await apiPost('/installerorder/orderstatusinfo', { installerNum: Number(installerNum) })
        for (const f of (Array.isArray(flagsR.obj) ? flagsR.obj : [])) {
          if (f && f.incident_id != null) notesAvail.set(f.incident_id, f.sR_NOTES_AVILABLE === 'Y')
        }
      } catch { /* optional */ }

      let done = 0
      for (const id of targets) {
        if (!readToken() || !ctxAlive()) { LOG('token/context lost mid-detail — stopping'); break }
        const item = byId.get(id)
        const avail = item.raw && item.raw.incident_id != null && notesAvail.has(item.raw.incident_id)
          ? notesAvail.get(item.raw.incident_id) : undefined
        const detail = await fetchDetail(item, installerNum, username, avail)
        if (detail) {
          await ingest('detail', detail)
          done++
          const n = (detail.raw.summary || []).length, dn = (detail.raw.documents || []).length, nt = (detail.raw.notes || []).length
          LOG(`detail #${id}: summary ${n}, docs ${dn}, notes ${nt}  (${done}/${targets.length})`)
          // Document FILES are downloaded by the SEPARATE doc-sync job (mode 'docs'),
          // not here — capturing them is slow and needs the authenticated session tab.
        } else {
          LOG(`detail #${id}: nothing captured`)
        }
        await sleep(250) // gentle pacing
      }
      LOG(`crawl complete — ${orders.length} orders, ${done} detailed`)
    } catch (e) {
      LOG('crawl error', e?.message || e)
    } finally {
      crawling = false
      endCrawl()
    }
  }

  // ── Reaching a logged-in hdprogram session ──────────────────────────────────
  function dismissLogoutModal() {
    const boxes = deepQueryAll('[role="dialog"], .modal, .ui-dialog, [class*="modal" i], [class*="dialog" i], [class*="popup" i]')
    for (const m of boxes) {
      if (!visible(m)) continue
      const txt = norm(m.innerText).toLowerCase()
      if (/log(ged)? ?out|session (has )?expired|please (log|sign) ?in|timed? ?out|no longer logged|been logged out/.test(txt)) {
        const btn = m.querySelector('button, a.btn, .btn, input[type="button"], input[type="submit"], a')
        if (btn) { LOG('logout modal detected → clicking through', norm(btn.innerText || btn.value || '')); realClick(btn); return true }
      }
    }
    return false
  }
  const looksBlank = () => ((document.body && document.body.innerText) || '').trim().length < 30
  function reloadOnce(tag) {
    const k = `clopay-reloaded-${tag}-${location.pathname}`
    try { if (sessionStorage.getItem(k)) return false; sessionStorage.setItem(k, '1') } catch { /* ignore */ }
    LOG(`blank Clopay page (${tag}) — reloading once to advance`)
    setTimeout(() => { try { location.reload() } catch { /* ignore */ } }, 800)
    return true
  }
  const findHdProgramTile = () => allElements(document)
    .filter(el => visible(el) && /^hd\s*program$/i.test(norm(el.innerText || '')))
    .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0]

  // After a fresh login the OIDC flow lands the crawl on cca.clopay.com. Click the
  // "HD Program" tile (or navigate directly) to reach hdprogram.clopay.com/orders.
  async function handleCcaDashboard() {
    if (!(await isCrawlTab())) { LOG('cca: not the crawl tab — leaving it alone'); return }
    const t0 = performance.now()
    const ms = () => Math.round(performance.now() - t0)
    LOG('cca: crawl tab — getting to HD Program orders')
    for (let i = 0; i < 120; i++) { // up to ~60s
      if (/hdprogram\.clopay\.com/.test(location.hostname)) return
      const tile = findHdProgramTile()
      if (tile) {
        const link = tile.closest('a, button, [role="link"], [role="button"]') || tile
        LOG(`cca: HD Program tile found at ${ms()}ms — clicking`)
        clickEl(link)
        for (let j = 0; j < 16; j++) { await sleep(500); if (/hdprogram\.clopay\.com/.test(location.hostname)) { LOG('cca: reached hdprogram'); return } }
        LOG(`cca: tile click didn't navigate by ${ms()}ms — navigating directly to orders`)
        location.href = LIST_URL
        return
      }
      const onDashboard = /my\s*clopay\s*programs|installer\s*tools/i.test(document.body.innerText || '')
      if (ms() >= 5000 && !onDashboard) {
        LOG(`cca: no dashboard at ${ms()}ms (${location.pathname}) — reloading once to advance`)
        if (reloadOnce('cca-advance')) return
      }
      await sleep(500)
    }
    LOG(`cca: no HD Program tile after ${ms()}ms — navigating directly to orders`)
    location.href = LIST_URL
  }

  // On hdprogram: wait until the bearer token exists (the app has authenticated),
  // then crawl. We do NOT wait for the (slow/broken) grid to render — the API doesn't
  // need it. Auto-crawl only when this is the crawl tab or a crawl mode is set, so a
  // manual visit doesn't kick off a crawl unexpectedly.
  let started = false
  async function driveHdProgram(reason) {
    if (started) return
    if (!ctxAlive()) { LOG('extension was reloaded — reload this tab (F5) to re-enable'); return }
    const mode = await getCrawlMode()
    const crawlTab = await isCrawlTab()
    if (!mode && !crawlTab) { LOG('hdprogram: not a crawl (no mode / not crawl tab) — idle'); return }
    started = true
    LOG('hdprogram:', reason, '— waiting for token')
    for (let i = 0; i < 240; i++) { // up to ~120s for the app to auth
      if (!ctxAlive()) return
      if (readToken()) {
        // mode 'docs' → the separate document-sync job; anything else → the fast crawl.
        if (mode === 'docs') { LOG(`token present after ~${i * 0.5}s — syncing documents`); await docsync() }
        else { LOG(`token present after ~${i * 0.5}s — crawling`); await crawl() }
        return
      }
      if (i === 16 && looksBlank()) { reloadOnce('hd-blank'); return } // truly blank OIDC landing → one reload
      await sleep(500)
    }
    LOG('hdprogram: no token after ~120s — session may not have authenticated'); endCrawl()
  }

  // ── Messages ─────────────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg?.type === `${NAME}-rescrape`) {
      if (/hdprogram\.clopay\.com/.test(location.hostname)) { crawl().then(() => reply({ ok: true })) }
      else { reply({ ok: false, error: 'not on hdprogram.clopay.com' }) }
      return true
    }
  })

  // ── Bootstrap ────────────────────────────────────────────────────────────────
  LOG('loaded on', location.href)
  dismissLogoutModal()
  setInterval(() => { try { dismissLogoutModal() } catch { /* ignore */ } }, 8000)
  if (/(^|\.)cca\.clopay\.com$/.test(location.hostname)) {
    handleCcaDashboard()
  } else if (/hdprogram\.clopay\.com/.test(location.hostname)) {
    driveHdProgram('initial-load')
    // The app may set the token / finish OIDC after a route change; retry the driver.
    let lastHref = location.href
    setInterval(() => {
      if (location.href !== lastHref) { lastHref = location.href; driveHdProgram('url-change') }
    }, 1500)
  }
})()
