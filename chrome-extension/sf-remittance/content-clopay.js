// Content script — Clopay HD Program installer portal at hdprogram.clopay.com.
// Runs inside the logged-in portal tab and reads the rendered DOM, sending
// scraped orders to the extension background, which forwards them to Castle
// Admin's /api/vendor-orders/ingest under vendor 'clopay_hd'.
//
// Mirrors content-genie.js end-to-end (list scrape + pagination, a storage-backed
// detail sweep with attempt caps + a watchdog, logout-modal dismissal → the
// shared content-login.js re-auth). Two surfaces:
//   • Order List   (/orders)            — a grid of all orders.
//   • Order Detail (/installer-details) — one order's Summary / Documents / Notes.
//
// The portal is a single-page app: clicking a row swaps in the detail view at the
// generic /installer-details URL (there is no per-order URL). We drive the sweep
// off the URL/content changing rather than off a full page reload, so it works
// whether the detail view is a real navigation or an in-place route change — and
// the sweep queue lives in chrome.storage so an accidental reload resumes.
//
// NOTE: this portal's exact markup is tuned against the live DOM. Selectors are
// anchored on visible label/header TEXT wherever possible, and every step logs
// under "[clopay]" — when the DOM differs, adjust the COLUMN/LABEL/selector maps
// below (nothing here depends on generated element ids).

(() => {
  const VENDOR = 'clopay_hd'
  const NAME = 'clopay'            // message-type prefix ('clopay-crawl-done', …) + log tag
  const MAX_PAGES = 40            // safety cap for list pagination
  const MAX_ATTEMPTS = 3          // per-order tries in a sweep before giving up (retried next crawl)
  const WATCHDOG_MS = 60000       // if a page doesn't progress in this long mid-sweep, recover to the list
  const SWEEP_STALE_MS = 15 * 60 * 1000 // a sweep older than this is abandoned, not resumed
  const LIST_URL = 'https://hdprogram.clopay.com/orders'
  const LIST_URL_RE = /\/orders(?:$|[/?#])/i
  const DETAIL_URL_RE = /installer-details/i
  const LOG = (...a) => console.log(`[${NAME}]`, ...a)
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
  const key = (s) => norm(s).toLowerCase().replace(/[:*]/g, '').trim()

  // 'MM/DD/YYYY' → 'YYYY-MM-DD' (ISO), else null.
  function toISO(s) {
    const m = norm(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)
    if (!m) return null
    let [, mo, d, y] = m
    if (y.length === 2) y = `20${y}`
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }

  /** Full mouse-event sequence — SPA row/tab handlers are delegated JS listeners
   *  that a bare .click() sometimes doesn't trigger. */
  function realClick(el) {
    for (const type of ['mousedown', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
    }
  }
  // Rect-based visibility — robust inside shadow DOM, where offsetParent is often
  // null even for on-screen elements.
  const visible = (el) => {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }

  // Every element in the document INCLUDING open shadow roots. Angular can render
  // components into shadow trees (ViewEncapsulation.ShadowDom), which a plain
  // querySelectorAll('*') — and innerText — can't see; that shows up as a visible
  // grid but bodyTextLen ~0. Traversing shadow roots makes the scraper see it.
  function allElements(root) {
    const out = []
    const stack = [root || document]
    while (stack.length) {
      const node = stack.pop()
      let els
      try { els = node.querySelectorAll('*') } catch { continue }
      for (const el of els) {
        out.push(el)
        if (el.shadowRoot) stack.push(el.shadowRoot)
      }
    }
    return out
  }
  // Like querySelectorAll, but pierces shadow roots (via allElements).
  function deepQueryAll(selector) {
    return allElements(document).filter(el => { try { return el.matches(selector) } catch { return false } })
  }

  // ── Order List ────────────────────────────────────────────────────────────
  // The portal is an Angular app — the grid is NOT a <table> / role="row"
  // structure, so we can't map by DOM rows. Instead we read the grid GEOMETRICALLY:
  // locate the column headers (PO DATE / PO / STORE / …), read their x-positions,
  // then bucket every visible text cell into a column by x and into a row by the
  // PO-DATE anchor's y. This is markup-agnostic (works for div/mat-row/custom
  // tags) and survives the lazy-scroll list.
  //   PO DATE · PO · STORE · ORDER TYPE · CUSTOMER DETAILS · CITY · STATUS · STATUS DATE
  const HEADERS = [
    { re: /^po\s*date$/i, field: 'order_date' },
    { re: /^po$/i, field: 'external_id' },
    { re: /^store$/i, field: 'store_number' },
    { re: /^order\s*type$/i, field: 'order_type' },
    { re: /^customer\s*details$/i, field: '__customer' },
    { re: /^city$/i, field: 'city' },
    { re: /^status\s*date$/i, field: '__statusDate' },
    { re: /^status$/i, field: 'status' },
  ]

  // A PO is alphanumeric on this portal (e.g. 60425672, RPP88431947, RP30448613),
  // so — unlike Genie's digits-only check — accept letters too.
  const isPo = (s) => /^[A-Z0-9][A-Z0-9-]{4,}$/i.test(norm(s))
  // An element's OWN text (direct text-node children only), so a wrapper div whose
  // text lives in descendants isn't mistaken for a leaf cell.
  function ownText(el) {
    let s = ''
    for (const n of el.childNodes) if (n.nodeType === 3) s += n.textContent + ' '
    return norm(s)
  }
  const absCenterX = (r) => r.left + r.width / 2
  const absTop = (r) => r.top + window.scrollY

  // Header columns, cached — the header can scroll out of view in the lazy list,
  // and x-positions don't change with vertical scroll, so once found we reuse them.
  let COLS_CACHE = null
  function detectColumns() {
    const found = []
    for (const el of allElements(document)) {
      if (!visible(el)) continue
      const t = ownText(el)
      if (!t) continue
      const h = HEADERS.find(h => h.re.test(t))
      if (!h || found.some(c => c.field === h.field)) continue
      const r = el.getBoundingClientRect()
      if (!r.width) continue
      // Store the header's LEFT edge — the grid's data is left-aligned under its
      // header, so the left edge (not the center) is what lines up with the cells.
      found.push({ field: h.field, left: r.left })
    }
    if (found.length < 5) return COLS_CACHE // keep whatever we had
    found.sort((a, b) => a.left - b.left)
    COLS_CACHE = { cols: found }
    return COLS_CACHE
  }

  // The column a left-aligned cell belongs to: the last header whose left edge is
  // at or before the cell's left edge (TOL absorbs padding/sub-pixel drift).
  // Cells left of the first column (sidebar) or well right of the last (chat
  // widget) return null.
  function columnForLeft(cols, leftX) {
    const TOL = 24
    if (leftX < cols[0].left - TOL) return null
    if (leftX > cols[cols.length - 1].left + 260) return null
    let col = null
    for (const c of cols) { if (leftX + TOL >= c.left) col = c; else break }
    return col
  }

  function scrapeListPage() {
    const detected = detectColumns()
    if (!detected) return []
    const { cols } = detected
    const anchorCol = cols.find(c => c.field === 'order_date') || cols.find(c => c.field === 'external_id')
    if (!anchorCol) return []

    // All visible leaf cells, assigned to a column by their LEFT edge. Header
    // cells are dropped by content (not by y) so a sticky header — whose
    // document-y grows as you scroll — never masks real rows.
    const isHeaderText = (t) => HEADERS.some(h => h.re.test(t))
    const leaves = []
    for (const el of allElements(document)) {
      if (!visible(el)) continue
      const t = ownText(el) // direct text only → wrappers contribute nothing, mixed nodes contribute their own text
      if (!t || isHeaderText(t)) continue
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) continue
      const col = columnForLeft(cols, r.left)
      if (!col) continue // outside the grid (sidebar, chat widget, etc.)
      leaves.push({ t, left: r.left, y: absTop(r), field: col.field })
    }

    // Row anchors: PO-DATE cells (a date in the anchor column). Each anchor's y
    // starts a row; the row spans to the next anchor (the last is height-capped so
    // it can't absorb anything rendered below the grid).
    const anchorIsDate = anchorCol.field === 'order_date'
    const anchors = leaves
      .filter(l => l.field === anchorCol.field && (anchorIsDate ? /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(l.t) : isPo(l.t)))
      .sort((a, b) => a.y - b.y)
    if (!anchors.length) return []

    const out = []
    for (let i = 0; i < anchors.length; i++) {
      const yTop = anchors[i].y - 6
      const yBot = i + 1 < anchors.length ? anchors[i + 1].y - 6 : anchors[i].y + 200
      const rowLeaves = leaves.filter(l => l.y >= yTop && l.y < yBot)
      const byField = {}
      for (const l of rowLeaves) (byField[l.field] ||= []).push(l)
      const o = {}, raw = {}
      for (const [field, arr] of Object.entries(byField)) {
        arr.sort((a, b) => a.y - b.y || a.left - b.left)
        const text = norm(arr.map(a => a.t).join(' '))
        if (field === '__customer') {
          // The CUSTOMER DETAILS cell holds the name and the street address —
          // sometimes as separate lines, sometimes in one text node ("SMITH JOHN
          // 402 8TH ST"). Split the joined text at the first street-number token:
          // everything before it is the name, from it on is the address.
          const m = text.match(/^(.+?)\s+(\d.*)$/)
          if (m) { o.customer_name = norm(m[1]); o.street_address = norm(m[2]) }
          else { o.customer_name = text || null }
          raw.customer_details = text
        } else if (field === '__statusDate') {
          raw.status_date = text || null
        } else if (field === 'order_date') {
          o.order_date = toISO(text)
        } else {
          o[field] = text || null
        }
      }
      if (Object.keys(raw).length) o.raw = raw
      if (o.external_id && isPo(o.external_id)) out.push(o)
    }
    return out
  }

  function rowCount() { return scrapeListPage().length }

  // Structural snapshot for live tuning — when the grid isn't recognized, this
  // tells us what the page actually looks like (paste it back to refine
  // selectors). Also exposed as window.__clopayDiag() to run by hand.
  function diagnostics() {
    const all = allElements(document)
    const count = (sel) => { try { return document.querySelectorAll(sel).length } catch { return -1 } }
    const shadowHosts = all.filter(el => el.shadowRoot).length
    const NOTEXT = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|LINK|META|HEAD)$/
    // What's actually RENDERED: visible leaf texts (excludes hidden modals, script/
    // style). If the grid is on screen we'll see PO/customer text here; if only the
    // shell is up we'll see header/nav text. This is the signal that tells apart
    // "not rendered yet" from "rendered but not recognized".
    const visibleTexts = []
    let renderedTextLen = 0
    for (const el of all) {
      if (NOTEXT.test(el.tagName) || !visible(el)) continue
      const t = ownText(el)
      if (t) { renderedTextLen += t.length; if (visibleTexts.length < 60) visibleTexts.push(t) }
    }
    const appRoot = document.querySelector('app-root')
    let cols = null
    try { const d = detectColumns(); if (d) cols = d.cols.map(c => ({ field: c.field, left: Math.round(c.left) })) } catch { /* ignore */ }
    const snap = {
      url: location.href,
      totalEls: all.length, shadowHosts,
      appRootDescendants: appRoot ? appRoot.querySelectorAll('*').length : -1,
      tables: count('table'), roleRows: count('[role="row"]'), iframes: count('iframe'),
      headersDetected: cols,
      renderedTextLen, bodyTextLen: (document.body?.innerText || '').length,
      visibleTextSample: visibleTexts.join(' | ').slice(0, 800),
    }
    LOG('DIAGNOSTIC', JSON.stringify(snap))
    return snap
  }
  function cssPath(el) {
    const parts = []
    for (let e = el; e && e.nodeType === 1 && parts.length < 6; e = e.parentElement) {
      let s = e.tagName.toLowerCase()
      if (e.id) { s += `#${e.id}`; parts.unshift(s); break }
      if (e.className && typeof e.className === 'string') s += '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.')
      parts.unshift(s)
    }
    return parts.join(' > ')
  }
  try { window.__clopayDiag = diagnostics } catch { /* ignore */ }

  // ── Pagination / lazy-load ──────────────────────────────────────────────
  // The list shows ~19 of ~169 → either a pager or scroll-to-load. Handle both:
  // page via a "next" control when present, else scroll the window/containers to
  // pull in more rows, until nothing new loads. Dedup by PO.
  function findNextPager() {
    const cands = deepQueryAll('.pagination a, .pagination li, ul.pagination *, nav a, [aria-label], a, button, li')
    return cands.find(el => {
      const t = norm(el.innerText)
      const meta = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.className || ''}`
      const isNext = t === '>' || t === '›' || t === '»' || /(?:^|[^a-z])next(?:[^a-z]|$)/i.test(meta)
      if (!isNext) return false
      const disabled = /disabl/i.test(el.className) || el.getAttribute('aria-disabled') === 'true' || el.disabled || el.closest('.disabled')
      return !disabled && visible(el)
    })
  }

  function pageSig() {
    const r = scrapeListPage()
    return r.length ? `${r[0].external_id}#${r.length}` : ''
  }

  async function waitForPageChange(prevSig, ms = 6000) {
    const start = Date.now()
    while (Date.now() - start < ms) { await sleep(200); if (pageSig() !== prevSig) return true }
    return false
  }

  // Scroll every plausibly-scrollable container (and the window) to the bottom, to
  // trigger lazy-load of the next batch.
  function scrollAllToBottom() {
    window.scrollTo(0, document.body.scrollHeight)
    for (const el of document.querySelectorAll('*')) {
      if (el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 120) { try { el.scrollTop = el.scrollHeight } catch { /* ignore */ } }
    }
  }

  async function scrapeAllListPages() {
    const byId = new Map()
    await sleep(1000) // let the grid bind
    const add = () => { for (const o of scrapeListPage()) if (o.external_id) byId.set(o.external_id, o) }

    if (findNextPager()) {
      // Classic pager.
      for (let page = 0; page < MAX_PAGES; page++) {
        add()
        let next = findNextPager()
        if (!next) { await sleep(500); next = findNextPager() }
        if (!next) break
        const prev = pageSig()
        let advanced = false
        for (let a = 0; a < 3 && !advanced; a++) { realClick(next); advanced = await waitForPageChange(prev) }
        if (!advanced) break
        if (page > 0 && page % 5 === 0) LOG(`paged ${page + 1}…`)
      }
    } else {
      // Scroll-to-load: keep scrolling until the row count stops growing.
      let stagnant = 0
      for (let i = 0; i < MAX_PAGES && stagnant < 2; i++) {
        const before = byId.size
        add()
        scrollAllToBottom()
        await sleep(1200)
        add()
        if (byId.size <= before) stagnant++; else stagnant = 0
      }
    }
    add()
    LOG(`collected ${byId.size} order(s)`)
    return [...byId.values()]
  }

  // ── Order Detail (/installer-details) ───────────────────────────────────
  // The customer card + three client-side tabs (Summary / Documents+Photos /
  // Notes). We click each tab, wait, and capture both a best-effort structured
  // form AND the panel's raw text (so anything the structured pass misses is still
  // captured in `raw` and easy to refine against).
  const TABS = [
    { label: 'summary', re: /summary/i, scrape: scrapeSummary },
    { label: 'documents', re: /documents?|photos?/i, scrape: scrapeDocuments },
    { label: 'notes', re: /notes?/i, scrape: scrapeNotes },
  ]

  function findTabControl(re) {
    return deepQueryAll('[role="tab"], button, a, li, .tab, .nav-link, [class*="tab" i]')
      .find(el => visible(el) && re.test(norm(el.innerText)) && norm(el.innerText).length < 40)
  }

  // The main detail/content region (excluding the tab strip), for raw-text capture.
  function detailPanel() {
    return (deepQueryAll('[role="tabpanel"], .tab-content, .tab-pane.active, main, [class*="detail" i]')[0] || document.body)
  }

  // Structural snapshot for tuning the DETAIL page — what tabs/controls we can see
  // and a sample of the rendered text. Also on window.__clopayDetailDiag().
  function detailDiagnostics() {
    const tabs = TABS.map(t => { const el = findTabControl(t.re); return { label: t.label, found: !!el, text: el ? norm(el.innerText).slice(0, 40) : null } })
    const clickable = deepQueryAll('[role="tab"], button, a, li').filter(visible)
      .map(el => norm(el.innerText)).filter(t => t && t.length < 30).slice(0, 40)
    const snap = {
      url: location.href,
      hasCustomerMarker: /PO\s*#/i.test(document.body.innerText),
      tabsFound: tabs,
      clickableLabels: clickable,
      links: deepQueryAll('a[href]').filter(visible).length,
      bodyTextSample: norm(document.body.innerText).slice(0, 900),
    }
    LOG('DETAIL DIAGNOSTIC', JSON.stringify(snap))
    return snap
  }
  try { window.__clopayDetailDiag = detailDiagnostics } catch { /* ignore */ }

  function scrapeSummary() {
    const panel = detailPanel()
    const summary = { _text: norm(panel.innerText).slice(0, 4000) }
    // Best-effort milestone timeline: rows/items that carry a label + a date and a
    // completed/pending marker (green check vs gray). Captured leniently.
    const items = [...panel.querySelectorAll('li, [class*="step" i], [class*="milestone" i], [class*="timeline" i], [class*="status" i], tr')]
    const milestones = []
    for (const el of items) {
      const text = norm(el.innerText)
      if (!text || text.length > 200) continue
      const date = (text.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/) || [])[0] || null
      const cls = `${el.className || ''} ${[...el.querySelectorAll('[class]')].map(x => x.className).join(' ')}`.toLowerCase()
      const done = /complete|done|success|green|check|active/.test(cls) || /✓|✔/.test(el.innerHTML)
      const label = norm(text.replace(/\d{1,2}\/\d{1,2}\/\d{2,4}.*$/, '')) || text
      if (label) milestones.push({ label, date, done })
    }
    if (milestones.length) summary.milestones = milestones
    // Payment: a PAID marker + doc #/date/amount if present.
    const payMatch = norm(panel.innerText).match(/payment[^$]*?(paid|pending|unpaid)?[^$]*?(?:\$?\s*([\d,]+\.\d{2}))?/i)
    if (payMatch && (payMatch[1] || payMatch[2])) summary.payment = { status: payMatch[1] || null, amount: payMatch[2] || null }
    return summary
  }

  function scrapeDocuments() {
    const panel = detailPanel()
    const out = []
    const seen = new Set()
    for (const a of panel.querySelectorAll('a[href]')) {
      const href = a.href
      if (!href || /^javascript:/i.test(href) || seen.has(href)) continue
      const name = norm(a.innerText) || norm(a.getAttribute('title') || a.getAttribute('aria-label') || '') || href.split('/').pop()
      const row = a.closest('li, tr, [class*="row" i], div')
      const date = (norm(row?.innerText || '').match(/\d{1,2}\/\d{1,2}\/\d{2,4}/) || [])[0] || null
      seen.add(href)
      out.push({ name, date, href })
    }
    // Rows that name a document/photo but have no link yet (metadata only).
    for (const el of panel.querySelectorAll('li, tr, [class*="document" i], [class*="photo" i]')) {
      const text = norm(el.innerText)
      if (!text || text.length > 160 || el.querySelector('a[href]')) continue
      if (/\.(pdf|jpe?g|png|docx?|xlsx?|tiff?)\b/i.test(text) || /document|photo|acknowledg|invoice/i.test(text)) {
        const date = (text.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/) || [])[0] || null
        out.push({ name: norm(text.replace(/\d{1,2}\/\d{1,2}\/\d{2,4}.*$/, '')) || text, date, href: null })
      }
    }
    return out
  }

  function scrapeNotes() {
    const panel = detailPanel()
    const out = []
    for (const el of panel.querySelectorAll('li, tr, [class*="note" i], [class*="comment" i], [class*="message" i]')) {
      const text = norm(el.innerText)
      if (!text || text.length > 800) continue
      const ts = (text.match(/\d{1,2}\/\d{1,2}\/\d{2,4}(?:[ ,]+\d{1,2}:\d{2}\s*[ap]?m?)?/i) || [])[0] || null
      const body = ts ? norm(text.replace(ts, '')) : text
      if (body) out.push({ text: body, timestamp: ts })
    }
    return out
  }

  // Customer card at the top of the detail view → name/address/phone/email + the
  // PO# + order type from the header ("DOOR DELIVERY · PO# 87932834").
  function scrapeCustomerCard(o) {
    const txt = norm(document.body.innerText)
    const po = (txt.match(/PO\s*#?\s*[:]?\s*([A-Z0-9][A-Z0-9-]{4,})/i) || [])[1]
    if (po) o.external_id = po
    const email = (txt.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [])[0]
    if (email) o.email = email
    const phone = (txt.match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/) || [])[0]
    if (phone) o.phone = phone
    const csz = txt.match(/([A-Za-z .'-]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/)
    if (csz) { o.city = o.city || norm(csz[1]); o.state_prov = csz[2]; o.postal_code = csz[3] }
    // Name is shown as "LAST, FIRST" immediately before the street address (a
    // number). Only set it when it matches that strict shape, so we never clobber
    // the list's name with header noise. Some orders have the name ONLY here.
    const nm = txt.match(/([A-Z][A-Za-z'’.\-]+,\s+[A-Z][A-Za-z'’.\- ]{1,40}?)\s+\d{1,6}\s+[A-Za-z]/)
    if (nm) o.customer_name = norm(nm[1])
    // Street address: the number + street that precedes "City, ST 00000".
    const addr = txt.match(/(\d{1,6}\s+[A-Za-z0-9][A-Za-z0-9 .'#\-]+?)\s*,?\s*[A-Za-z][A-Za-z .'-]+,\s*[A-Z]{2}\s+\d{5}/)
    if (addr) o.street_address = norm(addr[1].replace(/[\s,]+$/, ''))
    // Order type from the header, e.g. "DOOR DELIVERY · PO# …".
    const ot = txt.match(/([A-Z][A-Z /]{2,30}?)\s*[·|]\s*PO\s*#/i)
    if (ot) o.order_type = norm(ot[1])
  }

  async function scrapeDetail() {
    const o = { hasDetail: true }
    const raw = {}
    scrapeCustomerCard(o)
    for (const tab of TABS) {
      const ctl = findTabControl(tab.re)
      if (ctl) { realClick(ctl); await sleep(1200) }
      try {
        const data = tab.scrape()
        if (tab.label === 'summary') raw.summary = data
        else if (tab.label === 'documents') raw.documents = data
        else if (tab.label === 'notes') raw.notes = data
      } catch (e) { LOG(`detail: ${tab.label} scrape error`, e?.message || e) }
    }
    o.raw = raw
    if (!o.external_id) { LOG('detail: no PO found — DOM may differ'); return null }
    return o
  }

  // ── Page classification ──────────────────────────────────────────────────
  function looksLikeList() { return scrapeListPage().length > 0 }
  function looksLikeDetail() {
    return DETAIL_URL_RE.test(location.href) || TABS.some(t => !!findTabControl(t.re)) && !!scrapeCustomerCardMarker()
  }
  function scrapeCustomerCardMarker() { return /PO\s*#/i.test(document.body.innerText) }

  function pageType() {
    if (DETAIL_URL_RE.test(location.href)) return 'detail'
    if (LIST_URL_RE.test(location.href) && looksLikeList()) return 'list'
    if (looksLikeDetail()) return 'detail'
    if (looksLikeList()) return 'list'
    return null
  }

  // ── Crawl coordination (background) ──────────────────────────────────────
  // True only while this content script still has a live link to the extension.
  // After the extension is reloaded/updated, an already-injected script is
  // orphaned and every chrome.* call throws "Extension context invalidated" — so
  // we check this before touching chrome APIs and bail cleanly (the user just
  // needs to reload the tab to get a fresh script).
  function ctxAlive() { try { return !!(chrome.runtime && chrome.runtime.id) } catch { return false } }
  // Promise-returning chrome.storage.local.get that never throws on a dead context.
  function storageGet(defaults) {
    return new Promise(resolve => {
      if (!ctxAlive()) { resolve(defaults); return }
      try { chrome.storage.local.get(defaults, d => resolve(chrome.runtime.lastError ? defaults : d)) }
      catch { resolve(defaults) }
    })
  }
  const getCrawlMode = () => storageGet({ clopayCrawlMode: null }).then(d => d.clopayCrawlMode)
  function endCrawl() {
    if (!ctxAlive()) return
    try { chrome.storage.local.remove('clopayCrawlMode') } catch { /* ignore */ }
    try { chrome.runtime.sendMessage({ type: `${NAME}-crawl-done` }) } catch { /* SW asleep — timeout alarm covers it */ }
  }
  function isCrawlTab() {
    return new Promise(resolve => {
      if (!ctxAlive()) { resolve(false); return }
      try {
        chrome.runtime.sendMessage({ type: `${NAME}-crawl-tab?` }, (resp) => resolve(!chrome.runtime.lastError && !!(resp && resp.isCrawlTab)))
      } catch { resolve(false) }
    })
  }

  /** Post scraped orders to the background → Castle Admin ingest. Resolves with
   *  the ingest result (incl. needDetail), or null on error. */
  async function ingest(kind, payload) {
    if (!ctxAlive()) { LOG('extension link is gone — reload this tab (F5) to re-enable scraping'); return null }
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

  // ── Detail sweep (storage-backed, reload-resilient + SPA-friendly) ───────
  const SWEEP_KEY = 'clopaySweep'
  const getCfg = () => storageGet({ clopayAutoDetail: false, clopayMaxDetailPerRun: 12 })
  const getSweep = () => storageGet({ [SWEEP_KEY]: null }).then(d => d[SWEEP_KEY])
  const setSweep = (s) => new Promise(r => { if (!ctxAlive()) { r(); return } try { chrome.storage.local.set({ [SWEEP_KEY]: s }, r) } catch { r() } })
  const clearSweep = () => new Promise(r => { if (!ctxAlive()) { r(); return } try { chrome.storage.local.remove(SWEEP_KEY, r) } catch { r() } })

  async function waitForRows(ms = 20000) {
    const start = Date.now()
    while (Date.now() - start < ms) { if (rowCount()) return true; await sleep(500) }
    return false
  }

  // Return to the list. Prefer an in-app "back to orders" control (keeps the SPA
  // session warm); fall back to a hard navigation.
  function goToList() {
    const back = deepQueryAll('a, button').find(el =>
      visible(el) && /(my\s*)?hd\s*orders|back to orders|all orders|my orders/i.test(norm(el.innerText)))
    if (back) { LOG('returning to list via in-app control'); realClick(back); return }
    if (LIST_URL_RE.test(location.href)) location.reload()
    else location.href = LIST_URL
  }

  // Find the clickable element that opens order `id`'s detail. The PO shows as a
  // leaf cell; clicking the row opens it. We locate the leaf whose text is the PO,
  // then climb to the row-level ancestor (the one that also spans the other
  // columns) and click that — Angular's row handler is delegated, so a full mouse
  // sequence on the row container is what fires it.
  function findPoLeaf(id) {
    const target = String(id)
    return [...allElements(document)]
      .find(el => visible(el) && el.children.length === 0 && ownText(el) === target)
  }
  function findOrderOpener(id) {
    const leaf = findPoLeaf(id)
    if (!leaf) return null
    // Climb until the ancestor is wide enough to be the whole row (spans most of
    // the grid width), or we hit a real link/button/row element.
    let el = leaf
    const gridWidth = (COLS_CACHE && COLS_CACHE.cols.length)
      ? (COLS_CACHE.cols[COLS_CACHE.cols.length - 1].left - COLS_CACHE.cols[0].left + 200) : 600
    for (let hops = 0; el && hops < 8; hops++) {
      if (/^(a|button)$/i.test(el.tagName) || el.getAttribute('role') === 'row' || /(^|[-_ ])row([-_ ]|$)/i.test(el.className || '')) return el
      const w = el.getBoundingClientRect().width
      if (w >= gridWidth * 0.7) return el
      el = el.parentElement
    }
    return leaf.closest('a, button, [role="row"]') || leaf.parentElement || leaf
  }

  async function dropHead(sweep) {
    const [head, ...rest] = sweep.queue
    const attempts = { ...(sweep.attempts || {}) }; delete attempts[head]
    await setSweep({ ...sweep, queue: rest, attempts })
    return resumeSweepOnList()
  }

  /** On the list mid-sweep: locate the next queued order, click into its detail,
   *  then (for an in-place SPA route change) drive the detail scrape directly. A
   *  real navigation instead reloads the script, which resumes on the detail page
   *  via main(). Drops an order it can't open, or that has failed too many times. */
  async function resumeSweepOnList() {
    const sweep = await getSweep()
    if (!sweep || !sweep.queue.length) { await clearSweep(); endCrawl(); return }
    const id = sweep.queue[0]
    const attempts = { ...(sweep.attempts || {}) }
    attempts[id] = (attempts[id] || 0) + 1
    if (attempts[id] > MAX_ATTEMPTS) {
      LOG(`detail sweep: giving up on #${id} after ${MAX_ATTEMPTS} tries — skipping`)
      return dropHead({ ...sweep, attempts })
    }
    await setSweep({ ...sweep, attempts })
    LOG(`detail sweep: locating #${id} (${sweep.queue.length} left, try ${attempts[id]})`)
    await waitForRows()
    await sleep(800)

    // Locate the order, paging/scrolling toward it if needed.
    let opener = findOrderOpener(id), tries = 0
    while (!opener && tries < MAX_PAGES) {
      const next = findNextPager()
      if (next) { const prev = pageSig(); realClick(next); await waitForPageChange(prev) }
      else { const before = rowCount(); scrollAllToBottom(); await sleep(1000); if (rowCount() <= before) break }
      tries++
      opener = findOrderOpener(id)
    }
    if (!opener) { LOG(`detail sweep: could not find #${id} — skipping`); return dropHead(sweep) }

    // Click to open. If it's an in-place route change we stay in this context, so
    // poll for the detail view then scrape it directly; if it's a real nav the
    // page unloads mid-wait and the fresh load handles it.
    realClick(opener)
    for (let i = 0; i < 24; i++) {
      await sleep(500)
      if (pageType() === 'detail') { LOG(`detail sweep: #${id} opened in place`); return runDetail() }
    }
    LOG(`detail sweep: #${id} wouldn't open — skipping`)
    return dropHead(sweep)
  }

  async function runList() {
    // Mid-sweep: advance it instead of re-scraping — unless it's stale (crash
    // leftover), in which case drop it and start fresh.
    const active = await getSweep()
    if (active && active.queue.length) {
      const stale = !active.startedAt || (Date.now() - active.startedAt > SWEEP_STALE_MS)
      if (!stale) { await resumeSweepOnList(); return }
      LOG('detail sweep: discarding stale queue'); await clearSweep()
    }

    if (!(await waitForRows())) { LOG('list: no rows after waiting — DOM likely differs'); diagnostics(); return }
    const orders = await scrapeAllListPages()
    LOG(`list: scraped ${orders.length} order(s)`)
    const res = await ingest('list', orders)
    LOG('ingest result', res)

    const cfg = await getCfg()
    const mode = await getCrawlMode()
    const autoDetail = !!mode || cfg.clopayAutoDetail
    const cap = mode === 'full' ? 250 : mode === 'incremental' ? 25 : cfg.clopayMaxDetailPerRun
    if (autoDetail && res && res.needDetail && res.needDetail.length) {
      const queue = res.needDetail.slice(0, cap)
      LOG(`detail sweep: starting ${queue.length} of ${res.needDetail.length} needing detail${mode ? ` (${mode})` : ''}`)
      await setSweep({ queue, startedAt: Date.now() })
      await resumeSweepOnList()
    } else {
      endCrawl()
    }
  }

  async function runDetail() {
    let tries = 0, o = null
    while (tries++ < 40 && !(o = await safeScrapeDetail())) await sleep(500)
    if (o) { LOG('detail: scraped', o.external_id); detailDiagnostics(); await ingest('detail', o) }
    else { LOG('detail: nothing scraped — DOM likely differs'); detailDiagnostics() }

    const sweep = await getSweep()
    if (!sweep || !sweep.queue.length) return
    if (o) {
      const attempts = { ...(sweep.attempts || {}) }; delete attempts[o.external_id]
      const remaining = sweep.queue.filter(x => x !== o.external_id)
      if (remaining.length) { await setSweep({ ...sweep, queue: remaining, attempts }); LOG(`detail sweep: ${remaining.length} left, returning to list`); goToList(); await afterBackResume() }
      else { await clearSweep(); LOG('detail sweep: complete'); endCrawl(); goToList() }
    } else {
      LOG('detail sweep: scrape missed, returning to list to retry/skip'); goToList(); await afterBackResume()
    }
  }

  // After clicking "back to list" in an SPA (no reload), wait for the list to
  // reappear and continue the sweep in-place. If a real reload happened this never
  // runs (the fresh load's main() resumes instead).
  async function afterBackResume() {
    for (let i = 0; i < 30; i++) {
      await sleep(500)
      if (pageType() === 'list') { LOG('back on list in place — continuing sweep'); return resumeSweepOnList() }
    }
  }

  async function safeScrapeDetail() {
    try { return await scrapeDetail() } catch (e) { LOG('detail: scrape error', e?.message || e); return null }
  }

  // ── Drive it ───────────────────────────────────────────────────────────────
  async function main() {
    let type = pageType()
    for (let i = 0; !type && i < 20; i++) { await sleep(500); type = pageType() }

    const sweep = await getSweep()
    const sweeping = !!(sweep && sweep.queue.length)

    if (!type) {
      LOG('page not classified as list or detail'); diagnostics()
      if (sweeping) { LOG('unexpected page during sweep — recovering to list'); goToList() }
      return
    }

    // Watchdog: if a page stalls mid-sweep, recover to the list so one stuck page
    // can't wedge the whole crawl. A normal in-place advance clears nothing here,
    // so guard on still being on the SAME url + sweep after the timeout.
    if (sweeping) {
      const startedUrl = location.href
      setTimeout(async () => {
        const s = await getSweep()
        if (s && s.queue.length && location.href === startedUrl && pageType() !== 'list') { LOG('watchdog: page stalled, recovering to list'); goToList() }
      }, WATCHDOG_MS)
    }

    try {
      if (type === 'list') await runList()
      else if (type === 'detail') await runDetail()
    } catch (e) {
      LOG('run error — recovering', e?.message || e)
      if (sweeping) goToList()
    }
  }

  // Manual re-scrape from the console (single page, no sweep).
  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg?.type === `${NAME}-rescrape`) {
      const type = pageType()
      if (type === 'list') { scrapeAllListPages().then(o => ingest('list', o)).then(() => reply({ ok: true, type })) }
      else if (type === 'detail') { scrapeDetail().then(o => { if (o) ingest('detail', o); reply({ ok: !!o, type }) }) }
      else reply({ ok: false, error: 'not a Clopay order page' })
      return true
    }
  })

  // A "you're logged out" modal can appear on a stale/idle page. Click through it
  // so the browser navigates to the login page, where content-login.js re-auths
  // with the saved Clopay password — keeping the crawl going unattended.
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

  // ── Bootstrap ────────────────────────────────────────────────────────────
  // The orders app is an Angular SPA that paints AFTER this script is injected
  // (a fresh load showed bodyTextLen ~372 for many seconds) and route-changes
  // without reloading. So don't run once at document_idle — wait until the page
  // actually classifies (grid/detail rendered), run, and re-run on SPA URL change.
  let mainRunning = false
  async function runMainOnce(reason) {
    if (mainRunning) return
    if (!ctxAlive()) { LOG('extension was reloaded — reload this tab (F5) to re-enable Clopay scraping'); return }
    mainRunning = true
    try { LOG('run:', reason, '→', pageType()); await main() }
    catch (e) { LOG('main error', e?.message || e) }
    finally { mainRunning = false }
  }

  // Wait for the page to become classifiable, then run. The Clopay app can
  // pinwheel for a long time (observed >60s; the data sometimes loads late), so we
  // NEVER give up while the tab is open — we keep polling once a second until the
  // grid renders. Diagnostics fire at ~8s and ~60s for visibility, but the wait
  // continues past them. A generation token cancels a stale wait when the URL
  // changes (so an old wait can't fire runMain after we've moved on).
  let waitGen = 0
  function waitThenRun(reason) {
    const gen = ++waitGen
    let ticks = 0, fired = false
    const iv = setInterval(() => {
      if (gen !== waitGen) { clearInterval(iv); return } // superseded by a newer wait
      ticks++
      if (!fired && pageType()) {
        fired = true; clearInterval(iv); runMainOnce(reason)
      } else if (!fired && ticks === 8) {
        LOG('not classified after ~8s — diagnostic (grid may still be loading):'); diagnostics()
      } else if (!fired && ticks === 60) {
        LOG('still not classified after ~60s — the Clopay app is slow/pinwheeling; still waiting:'); diagnostics()
      }
      // else: keep waiting indefinitely until it renders.
    }, 1000)
  }

  // SPA route changes (orders ↔ installer-details) don't reload the script; watch
  // the URL so a manual navigation still scrapes.
  let lastHref = location.href
  setInterval(() => {
    if (location.href !== lastHref) { lastHref = location.href; LOG('URL changed →', location.href); COLS_CACHE = null; waitThenRun('url-change') }
  }, 1000)

  LOG('loaded on', location.href)
  dismissLogoutModal()
  setInterval(() => { try { dismissLogoutModal() } catch { /* ignore */ } }, 8000)
  waitThenRun('initial-load')
})()
