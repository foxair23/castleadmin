// Content script — Genie / Home Depot installer portal (Oracle WebCenter/ADF) at
// install.openings.net. Runs inside the logged-in portal tab and reads the
// rendered DOM (the ADF partial-postback API is stateful + unreplayable, so we
// scrape what the page shows). Sends scraped orders to the extension background,
// which forwards them to Castle Admin's /api/vendor-orders/ingest.
//
// Two surfaces:
//   • Order List  (…/installerconnect/orderlist | …/pages_orderlist) — a grid of
//     all orders (status, order #, PO, customer, dates, type, next step).
//   • Order Detail(…/installerconnect/orderdetails) — one order's full fields
//     (address, phones, email, scope).
//
// NOTE: selectors here are anchored on visible label/header TEXT, not Oracle's
// generated element ids (which rotate). If the live DOM differs, tune the
// COLUMN/LABEL maps below — everything logs under "[genie]" for easy debugging.

(() => {
  const VENDOR = 'genie_thd'
  const AUTO_PAGE = true          // walk all list pages (List.js client-side pager — instant, no network)
  const MAX_PAGES = 40            // safety cap
  const MAX_ATTEMPTS = 3          // per-order tries in a sweep before giving up (retried next crawl)
  const WATCHDOG_MS = 60000       // if a page doesn't progress in this long mid-sweep, recover to the list
  // Canonical order-list URL — the sweep returns here between orders. Using a
  // clean, stable URL (not whatever variant was opened, which may carry a stale
  // ?currentDate= cache-buster that doesn't re-render the grid) keeps it reliable.
  const LIST_URL = 'https://install.openings.net/webcenter/portal/installerconnect/orderlist'
  const LOG = (...a) => console.log('[genie]', ...a)
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
  const key = (s) => norm(s).toLowerCase().replace(/[:*]/g, '').trim()

  // '8/7/2026' → '2026-08-07' (ISO), else null.
  function toISO(s) {
    const m = norm(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
    if (!m) return null
    const [, mo, d, y] = m
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }

  // ── Order List ────────────────────────────────────────────────────────────
  // Header text → our field. Order also used as the positional fallback if the
  // header row can't be found.
  const LIST_COLUMNS = [
    { match: 'status', field: 'status' },
    { match: 'order number', field: 'external_id' },
    { match: 'customer po', field: 'customer_po' },
    { match: 'customer name', field: 'customer_name' },
    { match: 'order date', field: 'order_date', iso: true },
    { match: 'schedule date', field: 'schedule_date', iso: true },
    { match: 'order type', field: 'order_type' },
    { match: 'next step', field: 'next_step' },
    { match: 'document', field: null }, // document signature — ignore
  ]

  function rowsWithCells() {
    return [...document.querySelectorAll('tr')]
      .map(tr => ({ tr, cells: [...tr.children].map(c => norm(c.innerText)) }))
      .filter(r => r.cells.length >= 6)
  }

  function scrapeListPage() {
    const rows = rowsWithCells()
    if (!rows.length) return []
    // Locate the header row (contains "Order Number") to map columns; else use
    // the fixed positional order.
    const header = rows.find(r => r.cells.some(c => key(c).includes('order number')))
    let colMap // index → field
    if (header) {
      colMap = header.cells.map(txt => {
        const k = key(txt)
        const hit = LIST_COLUMNS.find(c => k.includes(c.match))
        return hit ? hit : null
      })
    } else {
      colMap = LIST_COLUMNS
      LOG('header row not found — using positional fallback')
    }
    const out = []
    for (const { cells } of rows) {
      if (header && cells === header.cells) continue
      const o = {}
      cells.forEach((val, i) => {
        const c = colMap[i]
        if (!c || !c.field) return
        o[c.field] = c.iso ? (toISO(val) ?? null) : (norm(val) || null)
      })
      // A real data row is identified by a numeric Order Number — robust across
      // any status wording (don't gate on the status column).
      if (o.external_id && /^\d{4,}$/.test(o.external_id)) out.push(o)
    }
    return out
  }

  // A signature of the current list page (first order + row count) so we can tell
  // when a pager click has actually swapped the rows in.
  function pageSig() {
    const r = scrapeListPage()
    return r.length ? `${r[0].external_id}#${r.length}` : ''
  }

  /** The pager's "next" control, if present and not on the last page. */
  function findNextPager() {
    const cands = [...document.querySelectorAll('.pagination a, .pagination li, ul.pagination *, nav a, a, button, span, li')]
    return cands.find(el => {
      const t = norm(el.innerText)
      const meta = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.className || ''}`
      const isNext = t === '>' || t === '›' || t === '»' || /(?:^|[^a-z])next(?:[^a-z]|$)/i.test(meta)
      if (!isNext) return false
      const disabled = /disabl/i.test(el.className) || el.getAttribute('aria-disabled') === 'true' || el.closest('.disabled')
      return !disabled && el.offsetParent !== null
    })
  }

  async function waitForPageChange(prevSig, ms = 6000) {
    const start = Date.now()
    while (Date.now() - start < ms) { await sleep(200); if (pageSig() !== prevSig) return true }
    return false
  }

  /** Scrape every list page by clicking through the client-side pager. Dedups by
   *  order number. Falls back to the current page if paging misbehaves. */
  async function scrapeAllListPages() {
    const byId = new Map()
    await sleep(1000) // let List.js bind the pager + row handlers before we page
    for (let page = 0; page < MAX_PAGES; page++) {
      for (const o of scrapeListPage()) if (o.external_id) byId.set(o.external_id, o)
      // The pager can render / bind its handler a beat after the rows, so re-find
      // it and fire a full mouse sequence, retrying until the page advances.
      let next = findNextPager()
      if (!next) { await sleep(500); next = findNextPager() }
      if (!next) break // truly the last page
      const prev = pageSig()
      let advanced = false
      for (let a = 0; a < 3 && !advanced; a++) { realClick(next); advanced = await waitForPageChange(prev) }
      if (!advanced) break // last page or stuck
      if (page > 0 && page % 5 === 0) LOG(`paged ${page + 1}…`)
    }
    LOG(`paged through ${byId.size} order(s)`)
    return [...byId.values()]
  }

  // ── Order Detail ──────────────────────────────────────────────────────────
  const DETAIL_LABELS = {
    'customer name': 'customer_name',
    'street address': 'street_address',
    'city, state zip': '__cityStateZip',
    'work phone': 'phone',
    'home phone': '__homePhone',
    'other': '__otherPhone',
    'email': 'email',
    'order number': 'external_id',
    'customer po': 'customer_po',
    'store number': 'store_number',
    'order type': 'order_type',
    'order status': 'status',
    'order date': 'order_date',
    'next task': 'next_step',
  }

  /** Value that visually follows a label. ADF renders label/value as adjacent
   *  cells or sibling nodes; we take the next element in document order that has
   *  its own non-empty text and isn't itself a known label. */
  function valueForLabel(labelText) {
    const target = key(labelText)
    const all = [...document.querySelectorAll('td, th, span, div, label, p')]
    for (let i = 0; i < all.length; i++) {
      const el = all[i]
      // element's own text (exclude descendants' text to avoid matching big containers)
      const own = norm([...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' '))
      if (key(own) !== target) continue
      // walk forward for the next element with its own non-empty, non-label text
      for (let j = i + 1; j < all.length && j < i + 40; j++) {
        const v = norm([...all[j].childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' '))
        if (!v) continue
        if (DETAIL_LABELS[key(v)]) break // hit the next label → this one had no value
        return v
      }
      return null
    }
    return null
  }

  // Extra labels we don't have typed columns for — captured into `raw` so nothing
  // on the detail page is lost (promote to columns later if needed).
  const EXTRA_LABELS = ['source from', 'mxp number', 'vendor site name', 'year home built', 'schedule date']

  function scrapeDetail() {
    const o = { hasDetail: true }
    const tmp = {}
    const raw = {}
    for (const [label, field] of Object.entries(DETAIL_LABELS)) {
      const v = valueForLabel(label)
      if (v == null) continue
      raw[label] = v
      if (field.startsWith('__')) tmp[field] = v
      else if (field === 'order_date') o[field] = toISO(v) ?? null
      else o[field] = v
    }
    for (const label of EXTRA_LABELS) {
      const v = valueForLabel(label)
      if (v != null) raw[label] = v
    }
    // phone fallback: work → home → other
    if (!o.phone) o.phone = tmp.__homePhone || tmp.__otherPhone || null
    // "Santee, CA 92071" → city / state / zip
    if (tmp.__cityStateZip) {
      const m = tmp.__cityStateZip.match(/^(.*?),\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/)
      if (m) { o.city = m[1].trim(); o.state_prov = m[2].toUpperCase(); o.postal_code = m[3] }
    }
    // scope: first line-item description (e.g. "(INSTALL RETAIL GDO CHAMBL)")
    const scopeRow = rowsWithCells().find(r => /install|gdo|opener|door/i.test(r.cells.join(' ')))
    if (scopeRow) {
      const desc = scopeRow.cells.find(c => /install|gdo|opener|door/i.test(c))
      if (desc) o.scope = desc.replace(/^\(|\)$/g, '').trim()
    }
    o.raw = raw
    if (!o.external_id) { LOG('detail: no order number found — DOM may differ'); return null }
    return o
  }

  // ── Drive it ───────────────────────────────────────────────────────────────
  // The order list grid is present (a header row naming "Order Number" + ≥1 data row).
  function looksLikeList() {
    return rowsWithCells().some(r => r.cells.some(c => key(c).includes('order number'))) && scrapeListPage().length > 0
  }
  // A single order's detail page (labelled fields the list grid never has).
  function looksLikeDetail() {
    return valueForLabel('street address') != null || valueForLabel('store number') != null
  }

  function pageType() {
    const u = location.href
    if (/orderdetails/i.test(u)) return 'detail'
    if (/orderlist/i.test(u)) return 'list'
    // Oracle WebCenter also serves these pages under opaque internal .jspx URLs
    // (…/oracle/webcenter/page/…Page….jspx) with no 'orderlist'/'orderdetails'
    // hint — so fall back to classifying by page content.
    if (looksLikeList()) return 'list'
    if (looksLikeDetail()) return 'detail'
    return null
  }

  /** Post scraped orders to the background → Castle Admin ingest. Resolves with
   *  the ingest result (incl. needDetail), or null on error. Tags the scrape mode
   *  (full/incremental from a scheduled crawl, else manual) for the health readout. */
  async function ingest(kind, payload) {
    const mode = (await getCrawlMode()) || 'manual'
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'genie', kind, mode, vendor: VENDOR, payload }, (res) => {
        if (chrome.runtime.lastError) { LOG('send error', chrome.runtime.lastError.message); resolve(null); return }
        resolve(res)
      })
    })
  }

  // ── Auto-detail sweep ────────────────────────────────────────────────────
  // Order detail has no direct URL — you must click the order-number link, which
  // navigates to the detail page. So the sweep is a state machine persisted in
  // chrome.storage across those navigations: hold a queue of order #s, click into
  // each, scrape on the detail page, return to the list, repeat. Gated by the
  // genieAutoDetail option (default off) and capped per run so it never runs away
  // or hijacks the portal unasked.
  const SWEEP_KEY = 'genieSweep'
  const getCfg = () => new Promise(r => chrome.storage.local.get({ genieAutoDetail: false, maxDetailPerRun: 12 }, r))
  const getSweep = () => new Promise(r => chrome.storage.local.get({ [SWEEP_KEY]: null }, d => r(d[SWEEP_KEY])))
  const setSweep = (s) => new Promise(r => chrome.storage.local.set({ [SWEEP_KEY]: s }, r))
  const clearSweep = () => new Promise(r => chrome.storage.local.remove(SWEEP_KEY, r))
  const findOrderLink = (id) => [...document.querySelectorAll('a')].find(a => norm(a.textContent) === String(id))

  // A scheduled crawl sets genieCrawlMode ('full' backfills everything nightly;
  // 'incremental' details only new orders hourly). Manual crawls leave it null.
  const getCrawlMode = () => new Promise(r => chrome.storage.local.get({ genieCrawlMode: null }, d => r(d.genieCrawlMode)))
  // Tell the background a crawl reached a terminal state, so a scheduled run can
  // close its tab. Harmless for manual crawls (background ignores non-crawl tabs).
  function endCrawl() {
    chrome.storage.local.remove('genieCrawlMode')
    try { chrome.runtime.sendMessage({ type: 'genie-crawl-done' }) } catch { /* SW asleep — timeout alarm covers it */ }
  }

  async function waitForRows(ms = 20000) {
    const start = Date.now()
    while (Date.now() - start < ms) { if (scrapeListPage().length) return true; await sleep(500) }
    return false
  }

  // Go to the clean list page. Forces a reload if we're already at that exact URL
  // (setting location.href to the current URL wouldn't navigate).
  function goToList() {
    if (location.href === LIST_URL) location.reload()
    else location.href = LIST_URL
  }

  /** Full mouse-event sequence — the portal's row navigation is a delegated JS
   *  handler that a bare .click() sometimes doesn't trigger. */
  function realClick(el) {
    for (const type of ['mousedown', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
    }
  }

  // A visible, clickable element whose text matches `re`. Prefers real links/
  // buttons; falls back to small text containers (not big wrappers).
  function findClickable(re) {
    const strong = [...document.querySelectorAll('a, button, [role="tab"], [role="link"], [onclick]')]
      .find(el => el.offsetParent !== null && re.test(key(el.innerText || el.value || '')))
    if (strong) return strong
    return [...document.querySelectorAll('span, li, div')]
      .find(el => el.offsetParent !== null && el.children.length <= 3 && re.test(key(el.innerText || '')))
  }

  // Opening the orders URL "cold" lands on the "All Program Home" interim page;
  // the list is reached by clicking Home Depot Opener → All Orders. Click the next
  // step toward the list (prefer the final "All Orders"). Returns true if clicked.
  function clickTowardOrders() {
    const all = findClickable(/all orders?/)
    if (all) { LOG('nav → All Orders'); realClick(all); return true }
    const opener = findClickable(/home ?depot.*opener|opener program/)
    if (opener) { LOG('nav → Home Depot Opener'); realClick(opener); return true }
    return false
  }

  // Is this the extension's crawl tab? Only then may we auto-navigate the portal
  // (so we never hijack the user's own browsing).
  function isCrawlTab() {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: 'genie-crawl-tab?' }, (resp) => {
          resolve(!chrome.runtime.lastError && !!(resp && resp.isCrawlTab))
        })
      } catch { resolve(false) }
    })
  }

  // Drop the head of the queue (and its attempt count) and move on.
  async function dropHead(sweep) {
    const [head, ...rest] = sweep.queue
    const attempts = { ...(sweep.attempts || {}) }; delete attempts[head]
    await setSweep({ ...sweep, queue: rest, attempts })
    return resumeSweepOnList()
  }

  /** On the list page mid-sweep: find the next queued order (paging to it if
   *  needed) and click into its detail. Drops an order it can't locate/open, or
   *  that has failed too many times (so one bad order never wedges the crawl). */
  async function resumeSweepOnList() {
    const sweep = await getSweep()
    if (!sweep || !sweep.queue.length) { await clearSweep(); endCrawl(); return }
    const id = sweep.queue[0]
    // Count this attempt; give up on an order that keeps failing.
    const attempts = { ...(sweep.attempts || {}) }
    attempts[id] = (attempts[id] || 0) + 1
    if (attempts[id] > MAX_ATTEMPTS) {
      LOG(`detail sweep: giving up on #${id} after ${MAX_ATTEMPTS} tries — skipping`)
      return dropHead({ ...sweep, attempts })
    }
    await setSweep({ ...sweep, attempts })
    LOG(`detail sweep: locating #${id} (${sweep.queue.length} left, try ${attempts[id]})`)
    await waitForRows()
    await sleep(1200) // let List.js bind row click handlers before we click
    let link = findOrderLink(id), pages = 0
    while (!link && pages < MAX_PAGES) {
      const next = findNextPager()
      if (!next) { LOG(`detail sweep: no next-page control while seeking #${id} (on page ${pages + 1})`); break }
      // The pager's click handler may not be bound yet right after a reload, so
      // fire a full mouse sequence and retry until the page actually advances.
      const prev = pageSig()
      let advanced = false
      for (let a = 0; a < 3 && !advanced; a++) { realClick(next); advanced = await waitForPageChange(prev) }
      if (!advanced) { LOG(`detail sweep: page wouldn't advance while seeking #${id}`); break }
      pages++
      link = findOrderLink(id)
    }
    if (!link) {
      LOG(`detail sweep: could not find #${id} — skipping`)
      return dropHead(sweep)
    }
    // Click to open the detail page. If the delegated handler wasn't live yet the
    // page won't navigate and this code keeps running — so retry a few times,
    // then skip. On a successful nav the page unloads mid-sleep and we stop here.
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) LOG(`detail sweep: #${id} didn't open, retry ${attempt}`)
      realClick(link)
      await sleep(2000)
      link = findOrderLink(id) || link // still running ⇒ no nav; re-find and retry
    }
    LOG(`detail sweep: #${id} wouldn't open — skipping`)
    return dropHead(sweep)
  }

  const SWEEP_STALE_MS = 15 * 60 * 1000 // a sweep older than this is abandoned, not resumed

  async function runList() {
    // Mid-sweep: don't re-scrape the whole list, just advance the sweep — unless
    // it's stale (left over from a prior session / a crash), in which case drop it
    // and start fresh so we never get wedged on an old queue.
    const active = await getSweep()
    if (active && active.queue.length) {
      const stale = !active.startedAt || (Date.now() - active.startedAt > SWEEP_STALE_MS)
      if (!stale) { await resumeSweepOnList(); return }
      LOG('detail sweep: discarding stale queue'); await clearSweep()
    }

    if (!(await waitForRows())) { LOG('list: no rows after waiting — DOM likely differs'); return }
    const orders = AUTO_PAGE ? await scrapeAllListPages() : scrapeListPage()
    LOG(`list: scraped ${orders.length} order(s) across ${AUTO_PAGE ? 'all pages' : 'this page'}`)
    const res = await ingest('list', orders)
    LOG('ingest result', res)

    const cfg = await getCfg()
    const mode = await getCrawlMode()
    // Scheduled crawls always detail (full backfills all; incremental just new).
    const autoDetail = !!mode || cfg.genieAutoDetail
    const cap = mode === 'full' ? 250 : mode === 'incremental' ? 25 : cfg.maxDetailPerRun
    if (autoDetail && res && res.needDetail && res.needDetail.length) {
      const queue = res.needDetail.slice(0, cap)
      LOG(`detail sweep: starting ${queue.length} of ${res.needDetail.length} needing detail${mode ? ` (${mode})` : ''}`)
      await setSweep({ queue, listUrl: LIST_URL, startedAt: Date.now() })
      // The full-list scrape left us on the LAST page; the sweep only pages
      // forward, so go to a clean page-1 list before it begins. The (fresh,
      // non-stale) sweep resumes on load.
      goToList()
    } else {
      endCrawl() // nothing to sweep — a scheduled crawl is done, close its tab
    }
  }

  async function runDetail() {
    let tries = 0, o = null
    while (tries++ < 40 && !(o = safeScrapeDetail())) await sleep(500)
    if (o) { LOG('detail: scraped', o.external_id); await ingest('detail', o) }
    else LOG('detail: nothing scraped — DOM likely differs')

    const sweep = await getSweep()
    if (!sweep || !sweep.queue.length) return
    // Advance: on a good scrape the order is done (remove it + its attempts); on a
    // miss, leave it in place so attempts-tracking retries/gives-up on next visit.
    if (o) {
      const attempts = { ...(sweep.attempts || {}) }; delete attempts[o.external_id]
      const remaining = sweep.queue.filter(x => x !== o.external_id)
      if (remaining.length) { await setSweep({ ...sweep, queue: remaining, attempts }); LOG(`detail sweep: ${remaining.length} left, returning to list`); goToList() }
      else { await clearSweep(); LOG('detail sweep: complete'); endCrawl() }
    } else {
      LOG('detail sweep: scrape missed, returning to list to retry/skip'); goToList()
    }
  }

  // scrapeDetail can touch a half-rendered/odd page; never let it throw the crawl dead.
  function safeScrapeDetail() {
    try { return scrapeDetail() } catch (e) { LOG('detail: scrape error', e?.message || e); return null }
  }

  async function main() {
    // On the clean URLs pageType() is known immediately; on opaque .jspx URLs it
    // depends on the ADF grid, which renders asynchronously — so poll briefly for
    // the content to appear before deciding the page is unclassifiable.
    let type = pageType()
    for (let i = 0; !type && i < 20; i++) { await sleep(500); type = pageType() }

    // Landed on a non-order portal page (e.g. the "All Program Home" interim page
    // the orders URL bounces to when "cold"). If this is the crawl's own tab,
    // click through to the orders list: Home Depot Opener → All Orders. Handles
    // ADF partial refreshes AND full navigations (the fresh page re-runs main()).
    if (!type && await isCrawlTab()) {
      for (let step = 0; step < 6 && !type; step++) {
        if (!clickTowardOrders()) { await sleep(1000); continue }
        for (let i = 0; !type && i < 16; i++) { await sleep(500); type = pageType() } // ~8s for nav/PPR
      }
    }

    const sweep = await getSweep()
    const sweeping = !!(sweep && sweep.queue.length)

    // Landed somewhere unexpected (blank/error/timeout page) mid-sweep → recover.
    if (!type) { if (sweeping) { LOG('genie: unexpected page during sweep — recovering to list'); goToList() } return }

    // Watchdog: if this page doesn't progress (navigate away) within the timeout,
    // recover to the list so one stuck page can't wedge the whole crawl. Normal
    // navigation unloads the page and cancels this; it only fires on a real stall,
    // and only if the sweep is still active.
    if (sweeping) {
      setTimeout(async () => {
        const s = await getSweep()
        if (s && s.queue.length) { LOG('genie watchdog: page stalled, recovering to list'); goToList() }
      }, WATCHDOG_MS)
    }

    try {
      if (type === 'list') await runList()
      else if (type === 'detail') await runDetail()
    } catch (e) {
      LOG('genie: run error — recovering', e?.message || e)
      if (sweeping) goToList()
    }
    return
  }

  // Manual re-scrape from the popup / console (single page, no sweep).
  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg?.type === 'genie-rescrape') {
      const type = pageType()
      if (type === 'list') { scrapeAllListPages().then(o => ingest('list', o)).then(() => reply({ ok: true, type })) }
      else if (type === 'detail') { const o = scrapeDetail(); if (o) ingest('detail', o); reply({ ok: !!o, type }) }
      else reply({ ok: false, error: 'not a Genie order page' })
      return true
    }
  })

  // A "you're logged out" modal can appear on a stale/idle page. Click through it
  // so the browser navigates to the login page, where content-genie-login.js
  // re-auths with the saved password — keeping the crawl going unattended.
  function dismissLogoutModal() {
    const boxes = [...document.querySelectorAll('[role="dialog"], .modal, .ui-dialog, [class*="modal" i], [class*="dialog" i], [class*="popup" i]')]
    for (const m of boxes) {
      if (m.offsetParent === null) continue // not visible
      const txt = norm(m.innerText).toLowerCase()
      if (/log(ged)? ?out|session (has )?expired|please (log|sign) ?in|timed? ?out|no longer logged|been logged out/.test(txt)) {
        const btn = m.querySelector('button, a.btn, .btn, input[type="button"], input[type="submit"], a')
        if (btn) { LOG('logout modal detected → clicking through', norm(btn.innerText || btn.value || '')); realClick(btn); return true }
      }
    }
    return false
  }

  LOG('loaded on', location.href, '→', pageType())
  dismissLogoutModal()
  setInterval(() => { try { dismissLogoutModal() } catch { /* ignore */ } }, 8000)
  main()
})()
