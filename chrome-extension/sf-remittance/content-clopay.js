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
  // Documents (GET /installerdocuments/{inst}/{incident}/{po}). The raw `url` field
  // points at an unresolvable internal host; the real, fetchable URL is deterministic:
  // hdprogram.clopay.com/showdocument/{documentId}.pdf (verified). We keep that as the
  // href (Clopay-authed fallback) and the id for downloading + de-duping the stored copy.
  function mapDocuments(arr) {
    if (!Array.isArray(arr)) return []
    return arr.map(d => {
      const id = d.documenT_ID != null ? String(d.documenT_ID).replace(/\.0$/, '') : null
      return {
        name: clean(d.filE_NAME) || clean(d.documenT_DESC) || (id ? `Document ${id}` : 'Document'),
        id,
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
  // Bridge to the MAIN-world fetch helper (content-clopay-main.js). Only a page-context
  // (main-world) fetch is authenticated for /showdocument — a background-worker or
  // isolated content-script fetch both get a ~15KB "not authorized" page. We ask the
  // main world to fetch and return the bytes as base64 over window.postMessage.
  let _fetchSeq = 0
  const _fetchPending = new Map()
  window.addEventListener('message', (e) => {
    const d = e.data
    if (e.source === window && d && d.__clopayFetchResult === true && _fetchPending.has(d.id)) {
      const resolve = _fetchPending.get(d.id); _fetchPending.delete(d.id); resolve(d)
    }
  })
  function fetchDocMainWorld(url) {
    return new Promise(resolve => {
      const id = ++_fetchSeq
      _fetchPending.set(id, resolve)
      window.postMessage({ __clopayFetch: true, id, url }, '*')
      setTimeout(() => { if (_fetchPending.has(id)) { _fetchPending.delete(id); resolve({ ok: false, error: 'timeout' }) } }, 25000)
    })
  }
  // Store one document. Dedup-check with the server first (skip if we already have it),
  // else download the PDF via the main-world bridge, validate it's really a PDF, and
  // hand the base64 bytes to the background to upload.
  async function storeDoc(external_id, documentId, docUrl, filename) {
    const chk = await msgBg({ type: 'clopay-store-doc', external_id, documentId, filename })
    if (!chk.ok) return { ok: false, error: chk.error || 'check failed' }
    if (chk.alreadyStored) return { ok: true, skipped: 'exists' }
    const f = await fetchDocMainWorld(docUrl)
    if (!f.ok) return { ok: false, error: `fetch ${f.status || f.error || '?'}` }
    const isImg = /^image\/(jpeg|png|heic|webp)$/.test(f.ct || '')
    const isPdf = typeof f.b64 === 'string' && f.b64.startsWith('JVBER') // base64 of "%PDF"
    if (!isPdf && !isImg) return { ok: false, error: `not a file (${f.size || 0}b, ${f.ct || '?'})` }
    const mime = isImg ? f.ct : 'application/pdf'
    return await msgBg({ type: 'clopay-store-doc', external_id, documentId, filename, mime, dataB64: f.b64 })
  }
  async function storeDocuments(detail) {
    const docs = (detail && detail.raw && detail.raw.documents) || []
    if (!docs.length) return
    let stored = 0, existing = 0, failed = 0
    for (const d of docs) {
      if (!d.id || !d.href) continue
      const r = await storeDoc(detail.external_id, d.id, d.href, d.name || `doc-${d.id}`)
      if (r.skipped) existing++
      else if (r.stored) stored++
      else { failed++; if (r.error) LOG(`doc ${d.id} store failed: ${r.error}`) }
    }
    LOG(`docs #${detail.external_id}: ${stored} stored, ${existing} existing, ${failed} failed`)
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
      const storeDocs = cfg.clopayStoreDocs !== false // download + store document files on our server
      LOG(`crawl start (installer ${installerNum}, mode ${mode || 'manual'}, storeDocs ${storeDocs})`)

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
          if (storeDocs) await storeDocuments(detail) // download + store the files on our server
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
      if (readToken()) { LOG(`token present after ~${i * 0.5}s — crawling`); await crawl(); return }
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
