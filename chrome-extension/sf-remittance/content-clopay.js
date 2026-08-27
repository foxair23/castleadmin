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
  const SWEEP_STALE_MS = 30 * 60 * 1000 // a sweep with no PROGRESS for this long is abandoned (startedAt is refreshed as orders complete, so an actively-progressing sweep never goes stale)
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
  /** Robust click for Angular controls (tabs, rows, buttons): scroll into view,
   *  then fire a full pointer+mouse sequence at the element's real on-screen point
   *  (dispatched on whatever is actually topmost there, so the framework's handler
   *  — which may sit on a parent — receives a properly-targeted, bubbling event).
   *  A bare synthetic click on a guessed element often doesn't navigate. */
  function clickEl(el) {
    if (!el) return false
    try { el.scrollIntoView({ block: 'center', inline: 'center' }) } catch { /* ignore */ }
    const r = el.getBoundingClientRect()
    const cx = Math.max(1, Math.min(window.innerWidth - 1, r.left + r.width / 2))
    const cy = Math.max(1, Math.min(window.innerHeight - 1, r.top + r.height / 2))
    const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 }
    // Dispatch on the element ITSELF (so its handler fires even if something sits
    // on top at that point) AND on whatever is topmost there; then the native
    // .click() for the default action (anchor routerLink / (click) handler).
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
    try { el.click() } catch { /* ignore */ } // native default action (most faithful)
    return true
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
          // Clopay's list "CUSTOMER DETAILS" cell is unreliable — it's rendered
          // address-first ("<street> <NAME>") and the NAME frequently belongs to a
          // different row (observed: order A's cell carrying order B's name). So we
          // do NOT trust the list name. Keep the whole cell in raw for reference,
          // capture just the street address (which IS row-aligned) when it's the
          // clear leading part, and leave customer_name for the DETAIL scrape to
          // fill authoritatively.
          raw.customer_details = text
          // Trailing "Last, First" (comma) is the one unambiguous case — split it.
          const comma = text.match(/^(\d.+?)\s+([A-Z][A-Za-z'’\-]+,\s*[A-Z][A-Za-z'’\-]+)$/)
          if (comma) { o.street_address = norm(comma[1]); o.customer_name = norm(comma[2]) }
          else if (/^\d/.test(text)) { o.street_address = text } // address-led: keep as address, name via detail
          else { o.customer_name = text } // name-led fallback (older layout)
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
  // Tab headers are plain elements with EXACTLY the label text (anchored so the
  // "IPO Document" card in the Summary panel isn't mistaken for the Documents tab).
  const TABS = [
    { label: 'summary', re: /^summary$/i, scrape: scrapeSummary },
    { label: 'documents', re: /^documents?\s*\/?\s*photos?$/i, scrape: scrapeDocuments },
    { label: 'notes', re: /^notes$/i, scrape: scrapeNotes },
  ]

  function findTabControl(re) {
    // The tab header may be a plain <div>/<span>, not a button/[role=tab]. Match any
    // visible element whose text is exactly the label; prefer the smallest (the
    // label itself rather than a wrapping container).
    const cands = allElements(document)
      .filter(el => visible(el) && re.test(norm(el.innerText || '')))
      .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)
    return cands[0]
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

  // Text of the active tab's content. Angular renders only the active tab, so the
  // page body is header + customer card + this tab; each parser filters the noise.
  // Pick the region with the MOST text (falling back to the whole body) — a
  // single-selector pick landed on an empty wrapper, which made every tab scrape
  // come back empty.
  function panelInnerText() {
    let best = (document.body && document.body.innerText) || ''
    for (const el of detailPanelCandidates()) {
      const t = (el && el.innerText) || ''
      if (t.length > best.length) best = t
    }
    return best
  }
  function detailPanelCandidates() {
    return deepQueryAll('[role="tabpanel"], .tab-content, .tab-pane.active, main, [class*="detail" i], app-installer-details').filter(visible)
  }
  // Lines that are the customer card / header, not tab content.
  const isCardLine = (l) => /@|\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}|,\s*[A-Z]{2}\s+\d{5}|PO\s*#/.test(l) || /^(call|email|directions)$/i.test(l)
  const isTabLine = (l) => /^(summary|documents?\/?\s?photos?|notes?)$/i.test(l)
  // Action buttons that live inside the Summary/Notes panels — never content.
  const isButtonLine = (l) => /^(add to calendar|start install|show notes|reschedule|·?\s*reschedule|edit|delete|reply)$/i.test(l)
  const isComposerLine = (l) => /castle\s*garage|add(\s+a)?\s+note|type (your|a) note|^send$|^post$|^\+$/i.test(l)
  const isTsLine = (l) => /^\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}\s*[AP]\.?M\.?/i.test(l) // "04/16/2026 12:54 PM"
  // Milestone headings (Summary). "New PO#" is a sub-line of Order Changes, not a
  // heading of its own, so it's intentionally NOT here.
  const MILESTONE_RE = /^(order received|site\s?check|order changes?|on order|shipment tracker|shipment|install|delivery|payment status|payment)\b/i

  function scrapeSummary() {
    const text = panelInnerText()
    const lines = text.split('\n').map(s => norm(s)).filter(Boolean)
    const milestones = []
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      // A milestone heading matches a known label, has no date of its own, is short.
      if (!MILESTONE_RE.test(l) || /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(l) || l.length > 40) continue
      const detailParts = []
      for (let j = i + 1; j < lines.length && j < i + 6; j++) {
        if (MILESTONE_RE.test(lines[j]) && lines[j].length <= 40) break
        if (isTabLine(lines[j]) || isCardLine(lines[j]) || isButtonLine(lines[j]) || isComposerLine(lines[j])) continue
        detailParts.push(lines[j])
      }
      const detail = norm(detailParts.join(' '))
      const date = (detail.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/) || [])[0] || null
      milestones.push({ label: l, detail: detail || null, date })
    }
    // Drop the persistent "add a note" composer label (org + user) from the raw
    // text so it isn't shown as Summary content.
    const cleanText = lines.filter(l => !/castle\s*garage/i.test(l)).join('\n')
    return { text: norm(cleanText).slice(0, 3000), milestones }
  }

  function scrapeDocuments() {
    const out = []
    const seen = new Set()
    for (const a of deepQueryAll('a[href]')) {
      if (!visible(a)) continue
      const href = a.href
      if (!href || /^javascript:/i.test(href) || seen.has(href)) continue
      const name = norm(a.innerText) || norm(a.getAttribute('title') || a.getAttribute('aria-label') || '') || href.split('/').pop()
      if (!name || /^(call|email|directions)$/i.test(name)) continue
      seen.add(href)
      out.push({ name, date: null, href })
    }
    // Text rows: a name line immediately followed by a date line (e.g. "New IPO" /
    // "08/25/26").
    const lines = panelInnerText().split('\n').map(s => norm(s)).filter(Boolean)
    for (let i = 0; i < lines.length - 1; i++) {
      const name = lines[i], next = lines[i + 1]
      if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(next) && !/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(name)
        && name.length <= 60 && !isTabLine(name) && !isCardLine(name) && !/^\d+\s+\S/.test(name)) {
        if (!out.some(d => d.name === name && d.date === next)) out.push({ name, date: next, href: null })
      }
    }
    return out
  }

  function scrapeNotes() {
    const raw = panelInnerText()
    if (/no notes to display/i.test(raw)) return []
    // Each note is one or more body lines followed by a timestamp line
    // ("04/16/2026 12:54 PM"). Accumulate body lines, and flush a note when the
    // timestamp line arrives. Skip the compose box, buttons, and the customer card.
    const lines = raw.split('\n').map(s => norm(s)).filter(Boolean)
    const out = []
    let body = []
    for (const l of lines) {
      if (isTabLine(l)) { body = []; continue } // clear the header/card that precedes the tab strip
      if (isCardLine(l) || isComposerLine(l) || isButtonLine(l) || /^\d+\s+\S/.test(l)) continue // skip card address/phone/etc.
      if (isTsLine(l)) {
        const text = norm(body.join(' '))
        if (text) out.push({ text, timestamp: l.replace(/\s*\|.*$/, '').trim() })
        body = []
      } else {
        body.push(l)
      }
    }
    // A trailing note with no timestamp line (rare).
    const tail = norm(body.join(' '))
    if (tail.length > 3) out.push({ text: tail, timestamp: null })
    return out
  }

  // Customer card at the top of the detail view. This is the AUTHORITATIVE source
  // for name + address (the list cell is mangled). The card is the smallest
  // visible element containing the "DIRECTIONS" button and a phone number; we read
  // its lines directly:  NAME / street / City, ST ZIP / phone / email / CALL EMAIL
  // DIRECTIONS.
  function scrapeCustomerCard(o) {
    const bodyTxt = norm(document.body.innerText)
    const po = (bodyTxt.match(/PO\s*#?\s*[:]?\s*([A-Z0-9][A-Z0-9-]{4,})/i) || [])[1]
    if (po) o.external_id = po
    const ot = bodyTxt.match(/([A-Z][A-Z /]{2,30}?)\s*[·|]\s*PO\s*#/i)
    if (ot) o.order_type = norm(ot[1])

    const phoneRe = /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/
    const card = deepQueryAll('*')
      .filter(el => visible(el) && /directions/i.test(el.innerText || '') && phoneRe.test(el.innerText || ''))
      .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0]
    const cardTxt = card ? card.innerText : document.body.innerText

    const email = (cardTxt.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [])[0]
    if (email) o.email = email
    const phone = (cardTxt.match(phoneRe) || [])[0]
    if (phone) o.phone = phone
    const csz = cardTxt.match(/([A-Za-z][A-Za-z .'-]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/)
    if (csz) { o.city = norm(csz[1]); o.state_prov = csz[2]; o.postal_code = csz[3] }

    const lines = cardTxt.split('\n').map(s => norm(s)).filter(Boolean)
      .filter(l => !/^(call|email|directions)$/i.test(l)) // drop the action buttons
    // Name: first line that isn't the address (no leading number), a phone, an
    // email, or the city/state/zip line.
    const nameLine = lines.find(l =>
      !/^\d/.test(l) && !/@/.test(l) && !phoneRe.test(l) && !(csz && l.includes(csz[0])) && /[A-Za-z]{2}/.test(l) && l.length < 60)
    if (nameLine) o.customer_name = nameLine
    // Street address: first line that starts with a number and isn't the city line.
    const addrLine = lines.find(l => /^\d+\s+\S/.test(l) && !(csz && l.includes(csz[0])))
    if (addrLine) o.street_address = norm(addrLine.replace(/[\s,]+$/, ''))
  }

  // Wait until the active tab's panel text stops growing (loaded) or a cap. Tabs
  // can take 4–8s to populate, so: never return before a small minimum (so a
  // spinner-then-content tab isn't scraped early), require the length to hold
  // steady across ~1.2s, and allow up to ~12s.
  async function waitForPanelStable(maxMs = 7000, minMs = 1000) {
    const start = performance.now()
    let prev = -1, stable = 0
    while (performance.now() - start < maxMs) {
      const len = panelInnerText().length
      if (len > 0 && len === prev) stable++; else stable = 0
      prev = len
      if (stable >= 3 && performance.now() - start >= minMs) return // steady ~1.2s and past the floor
      await sleep(400)
    }
  }

  // Some tabs (Notes/Documents on busy orders) lazy-load more rows as you scroll,
  // so scroll the window + any scrollable container to the bottom repeatedly until
  // the panel text stops growing, then return to the top. Without this we only
  // capture what's initially visible.
  async function loadAllInPanel(maxMs = 15000) {
    const start = performance.now()
    let prev = -1, stable = 0
    while (performance.now() - start < maxMs) {
      scrollAllToBottom()
      await sleep(600)
      const len = panelInnerText().length
      if (len === prev) { if (++stable >= 2) break } else stable = 0
      prev = len
    }
    try { window.scrollTo(0, 0) } catch { /* ignore */ }
    for (const el of document.querySelectorAll('*')) { if (el.scrollTop > 0) try { el.scrollTop = 0 } catch { /* ignore */ } }
  }

  // A short signature of the tab-panel content, to tell whether a tab click
  // actually switched the panel (vs. a click that didn't register).
  const panelSig = () => { const t = norm(panelInnerText()); return `${t.length}:${t.slice(0, 40)}:${t.slice(-40)}` }

  async function scrapeDetail() {
    const o = { hasDetail: true }
    const raw = {}
    scrapeCustomerCard(o)
    // The tab strip can render seconds after the customer card (and pinwheel), so
    // wait for the whole tab bar (first + last tab) to exist before touching it.
    for (let i = 0; i < 60; i++) { // up to ~24s
      if (findTabControl(TABS[0].re) && findTabControl(TABS[TABS.length - 1].re)) break
      await sleep(400)
    }
    let prevSig = panelSig() // the (Summary) panel we start on
    const deadline = performance.now() + 45000 // hard cap so one long order can't wedge the sweep
    for (const tab of TABS) {
      if (performance.now() > deadline) { LOG(`detail: time budget hit — capturing ${tab.label}+ from what's loaded`); break }
      let ctl = null
      for (let i = 0; i < 12 && !ctl; i++) { ctl = findTabControl(tab.re); if (!ctl) await sleep(400) }
      if (!ctl) { LOG(`detail: ${tab.label} tab not found`); continue }

      // Summary is the default tab (already showing); the others must be switched
      // to. A synthetic click often doesn't register until the tab is interactive,
      // so re-click until the panel content actually CHANGES — otherwise we'd
      // scrape the Summary panel again as "documents"/"notes".
      let switched = tab.label === 'summary'
      for (let attempt = 0; attempt < 5 && !switched; attempt++) {
        LOG(`detail: clicking ${tab.label} tab (try ${attempt + 1})`)
        clickEl(ctl)
        for (let i = 0; i < 10; i++) { // ~4s to register the switch
          await sleep(400)
          if (panelSig() !== prevSig) { switched = true; break }
        }
        if (!switched) ctl = findTabControl(tab.re) || ctl
      }
      if (!switched && tab.label !== 'summary') { LOG(`detail: ${tab.label} tab did not switch — skipping`); continue }

      await waitForPanelStable()  // let the (now-switched) panel finish loading
      if (tab.label !== 'summary') await loadAllInPanel(10000) // scroll to pull in lazy rows (long Notes/Docs)
      prevSig = panelSig()
      try {
        const data = tab.scrape()
        const n = tab.label === 'summary' ? (data.milestones || []).length : (Array.isArray(data) ? data.length : 0)
        LOG(`detail: ${tab.label} captured ${n} item(s)`)
        if (tab.label === 'summary') { raw.summary = data.milestones; raw.summary_text = data.text }
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

  // Persistent per-order "give up" set. When an order exhausts its attempts (can't
  // open, or keeps scraping empty), we record it here with a timestamp and exclude
  // it from the queue — so restarting the crawler mid-backfill does NOT reopen the
  // same stuck job again and again. Entries expire after SKIP_TTL so the next day's
  // crawl retries them. Together with the attempt ledger below, this enforces
  // "never come back to a job more than MAX_ATTEMPTS times" across restarts.
  const SKIP_KEY = 'clopayDetailSkip'
  const SKIP_TTL = 6 * 60 * 60 * 1000 // 6h
  const getSkipRaw = () => storageGet({ [SKIP_KEY]: {} }).then(d => d[SKIP_KEY] || {})
  const setSkipRaw = (m) => new Promise(r => { if (!ctxAlive()) { r(); return } try { chrome.storage.local.set({ [SKIP_KEY]: m }, r) } catch { r() } })
  async function addSkip(id) {
    if (!id) return
    const m = await getSkipRaw(); m[id] = Date.now(); await setSkipRaw(m)
    LOG(`detail sweep: set #${id} aside for ${Math.round(SKIP_TTL / 3600000)}h (won't reopen this backfill)`)
  }
  // Live skip ids (unexpired), pruning stale entries as a side effect.
  async function activeSkip() {
    const m = await getSkipRaw(), now = Date.now(), live = {}, set = new Set()
    for (const [id, ts] of Object.entries(m)) if (now - ts < SKIP_TTL) { live[id] = ts; set.add(id) }
    if (Object.keys(live).length !== Object.keys(m).length) await setSkipRaw(live)
    return set
  }

  // Per-order attempt ledger — how many times we've OPENED each order this backfill.
  // Kept in its OWN storage key (not in the sweep object) on purpose: the sweep's
  // queue is rebuilt from scratch every time the list is re-scraped, which used to
  // reset the in-sweep attempts counter to zero and let a stuck order (e.g. one
  // that keeps forcing a list reload) be reopened forever. This ledger survives
  // those rebuilds, so the MAX_ATTEMPTS cap actually holds. TTL'd like the skip set.
  const ATT_KEY = 'clopayDetailAttempts'
  const getAttRaw = () => storageGet({ [ATT_KEY]: {} }).then(d => d[ATT_KEY] || {})
  const setAttRaw = (m) => new Promise(r => { if (!ctxAlive()) { r(); return } try { chrome.storage.local.set({ [ATT_KEY]: m }, r) } catch { r() } })
  async function bumpAttempt(id) {
    const m = await getAttRaw(), now = Date.now()
    const prev = m[id] && (now - m[id].ts < SKIP_TTL) ? m[id].n : 0
    m[id] = { n: prev + 1, ts: now }
    await setAttRaw(m)
    return prev + 1
  }
  async function clearAttempt(id) {
    if (!id) return
    const m = await getAttRaw()
    if (m[id]) { delete m[id]; await setAttRaw(m) }
  }
  // Does a scraped detail object actually carry detail-page content? An order that
  // opens but scrapes empty is treated as a failed attempt (retried, then skipped),
  // not "done" — otherwise it would fall out of the queue yet still lack detail and
  // get re-queued on every future crawl. Mirrors the server's hasStoredDetail().
  function detailHasContent(o) {
    const r = o && o.raw
    if (!r || typeof r !== 'object') return false
    if (typeof r.summary_text === 'string' && r.summary_text.trim()) return true
    if (Array.isArray(r.summary) && r.summary.length) return true
    if (Array.isArray(r.notes) && r.notes.length) return true
    if (Array.isArray(r.documents) && r.documents.length) return true
    return false
  }

  async function waitForRows(ms = 20000) {
    const start = Date.now()
    while (Date.now() - start < ms) { if (rowCount()) return true; await sleep(500) }
    return false
  }

  // Return to the list by clicking the "My HD Orders" button on the detail page
  // (fast, keeps the SPA warm) — a hard URL navigation is the slow last resort.
  // The button can be a plain <div>/<span>, so match any small visible element
  // whose text is the button label, then click it robustly.
  function findBackToList() {
    const cands = allElements(document).filter(el =>
      visible(el) && /^(my\s*hd\s*orders|back to orders|all orders|my orders)$/i.test(norm(el.innerText || '')))
    cands.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)
    return cands[0]
  }
  function goToList() {
    const back = findBackToList()
    if (back) { LOG('returning to list via "My HD Orders" button'); clickEl(back); return }
    LOG('back button not found — falling back to URL nav (slow)')
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
    await addSkip(head) // failed to open / scrape → set aside so a restart won't reopen it
    await setSweep({ ...sweep, queue: rest, current: null })
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
    // Count this open in the PERSISTENT ledger (survives sweep-queue rebuilds) and
    // stop the moment an order has been opened MAX_ATTEMPTS times this backfill —
    // this is the hard "never come back to the same job more than 3 times" rule.
    const nAttempt = await bumpAttempt(id)
    if (nAttempt > MAX_ATTEMPTS) {
      LOG(`detail sweep: giving up on #${id} after ${MAX_ATTEMPTS} opens this backfill`)
      return dropHead(sweep) // dropHead records the skip so it's excluded on restarts
    }
    // Remember which id we're opening so runDetail removes THIS one from the queue
    // (the detail page's scraped PO can differ from the list id; keying advancement
    // off the detail PO left the head in place and re-opened the same order).
    await setSweep({ ...sweep, current: id })
    LOG(`detail sweep: locating #${id} (${sweep.queue.length} left, open ${nAttempt}/${MAX_ATTEMPTS})`)
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

    // Click to open, then give a SINGLE click up to ~18s to land on the detail
    // view before re-clicking — a slow-loading order (observed ~8s) must not be
    // re-clicked mid-load, which cancels the navigation and wedges the sweep.
    for (let attempt = 0; attempt < 2; attempt++) {
      clickEl(opener)
      for (let i = 0; i < 36; i++) {
        await sleep(500)
        if (pageType() === 'detail') { LOG(`detail sweep: #${id} opened`); return runDetail() }
      }
      opener = findOrderOpener(id) || opener
      LOG(`detail sweep: #${id} didn't open in ~18s, retry ${attempt + 1}`)
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
    // Detail only the orders the server says still LACK real detail (needDetail now
    // reflects stored content, not just detail_scraped_at). This is what makes a
    // backfill resumable: each (re)start queues only what's still missing, so
    // restarting the crawler 10× never starts from the beginning — already-indexed
    // orders have dropped off the list. `full` just uses a big cap so one run can
    // clear the whole backlog; `incremental`/manual use smaller caps.
    const needDetail = (res && res.needDetail) || []
    const skip = await activeSkip()
    const targets = needDetail.filter(id => !skip.has(id))
    if (autoDetail && targets.length) {
      const queue = targets.slice(0, cap)
      const setAside = needDetail.length - targets.length
      LOG(`detail sweep: starting ${queue.length} of ${needDetail.length} needing detail${setAside ? ` (${setAside} set aside)` : ''}${mode ? ` (${mode})` : ''}`)
      await setSweep({ queue, startedAt: Date.now() })
      await resumeSweepOnList()
    } else {
      if (autoDetail) LOG(`detail sweep: nothing left to detail${needDetail.length ? ` (${needDetail.length} set aside)` : ''} — backfill complete`)
      endCrawl()
    }
  }

  // The customer card (PO#) has rendered → the detail page is ready enough to
  // scrape. The Summary tab can still be pinwheeling; we give it a short grace
  // period but never block the whole crawl on one slow page.
  function detailReady() { return /PO\s*#/i.test(document.body.innerText) && !!scrapeCustomerCardMarker() }

  async function runDetail() {
    // Wait (bounded) for the page to render, then scrape ONCE. Retrying the full
    // scrape — which clicks all 3 tabs — on a pinwheeling page burned minutes and
    // looked stuck; cap the wait and move on instead.
    const t0 = performance.now()
    let ready = false
    for (let i = 0; i < 50 && !ready; i++) { if (detailReady()) ready = true; else await sleep(500) }
    LOG(ready ? `detail: page ready in ${Math.round(performance.now() - t0)}ms` : 'detail: page did not render in ~25s — skipping')
    if (ready) await sleep(1000) // small grace before the tab-bar wait inside scrapeDetail
    const o = ready ? await safeScrapeDetail() : null
    // Always ingest what we got (even a content-less scrape carries the customer
    // card's phone/email), but only ADVANCE past the order when real detail landed.
    if (o) { LOG('detail: scraped', o.external_id, `in ${Math.round(performance.now() - t0)}ms`); await ingest('detail', o) }
    else if (ready) LOG('detail: nothing scraped — DOM differs')
    const complete = detailHasContent(o)

    const sweep = await getSweep()
    if (!sweep || !sweep.queue.length) return
    if (complete) {
      // Remove the id we OPENED (and the detail's PO, if different) so we always
      // advance past this order — never re-open the same one. Clear its attempt
      // ledger entry: it succeeded, so a future crawl may re-detail it freely.
      const opened = sweep.current || o.external_id
      await clearAttempt(opened); await clearAttempt(o.external_id)
      const remaining = sweep.queue.filter(x => x !== opened && x !== o.external_id)
      // Refresh startedAt so an actively-progressing sweep survives a crawl-timeout
      // and resumes (rather than going stale and restarting from the front).
      if (remaining.length) { await setSweep({ ...sweep, queue: remaining, current: null, startedAt: Date.now() }); LOG(`detail sweep: ${remaining.length} left, returning to list`); goToList(); await afterBackResume() }
      else { await clearSweep(); LOG('detail sweep: complete'); endCrawl(); goToList() }
    } else {
      // Opened but no real detail (empty/partial render). Back to the list — the
      // attempts counter ticks up there and, once it hits MAX_ATTEMPTS, the order
      // is set aside so we don't keep reopening it.
      LOG('detail sweep: no content scraped, returning to list to retry/skip'); goToList(); await afterBackResume()
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

  // Clopay's OIDC hops land on blank pages that only advance after a reload (the
  // post-login cca.clopay.com/login, and the blank page the HD Program click lands
  // on). A near-empty <body> is the signal; reload once per page (guarded so it
  // never loops). A slow/pinwheeling app page is NOT blank (it has the header/
  // sidebar shell), so this never fights a page that's merely rendering.
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

  // After a fresh login the OIDC flow lands the crawl on cca.clopay.com, not the
  // orders app. Manual path: (the blank /login settles →) dashboard → click "HD
  // Program" → hdprogram.clopay.com/orders. Do the same, only in the crawl tab.
  // Real elapsed time gates the blank-page reload (so it never fires early), and
  // a direct navigation guarantees we reach orders even if the tile click doesn't.
  async function handleCcaDashboard() {
    if (!(await isCrawlTab())) { LOG('cca: not the crawl tab — leaving it alone'); return }
    const t0 = performance.now()
    const ms = () => Math.round(performance.now() - t0)
    LOG('cca: crawl tab — getting to HD Program orders')
    for (let i = 0; i < 120; i++) { // up to ~60s
      if (/hdprogram\.clopay\.com/.test(location.hostname)) return // already navigated away
      const tile = findHdProgramTile()
      if (tile) {
        const link = tile.closest('a, button, [role="link"], [role="button"]') || tile
        LOG(`cca: HD Program tile found at ${ms()}ms — clicking`)
        clickEl(link)
        for (let j = 0; j < 16; j++) { await sleep(500); if (/hdprogram\.clopay\.com/.test(location.hostname)) { LOG('cca: reached hdprogram'); return } }
        // Click didn't navigate → SSO is live, so go straight to orders.
        LOG(`cca: tile click didn't navigate by ${ms()}ms — navigating directly to orders`)
        location.href = LIST_URL
        return
      }
      // The post-login /login (and OIDC hops) render without the dashboard and
      // need a refresh to advance. If after a genuine 5s there's no dashboard yet
      // (no tile and no dashboard markers), reload once. The real dashboard has
      // "My Clopay Programs" / "Installer Tools", so we never reload it.
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

  // On the orders app (hdprogram) a blank OIDC landing also needs one reload to
  // advance; the normal render wait handles a merely-slow page.
  function startBlankWatcher() {
    let ticks = 0
    const iv = setInterval(() => {
      ticks++
      if (!ctxAlive() || pageType()) { clearInterval(iv); return } // rendered/classifiable → stop
      if (ticks >= 12 && looksBlank()) { clearInterval(iv); reloadOnce('hd-blank') } // ~6s truly blank → reload once
      if (ticks > 60) clearInterval(iv)
    }, 500)
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
  if (/(^|\.)cca\.clopay\.com$/.test(location.hostname)) handleCcaDashboard()
  else { startBlankWatcher(); waitThenRun('initial-load') }
})()
