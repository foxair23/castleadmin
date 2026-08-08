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
    for (let page = 0; page < MAX_PAGES; page++) {
      for (const o of scrapeListPage()) if (o.external_id) byId.set(o.external_id, o)
      const next = findNextPager()
      if (!next) break
      const prev = pageSig()
      next.click()
      if (!(await waitForPageChange(prev))) break // last page or stuck
      if (page > 0 && page % 5 === 0) LOG(`paged ${page + 1}…`)
    }
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

  function scrapeDetail() {
    const o = { hasDetail: true }
    const tmp = {}
    for (const [label, field] of Object.entries(DETAIL_LABELS)) {
      const v = valueForLabel(label)
      if (v == null) continue
      if (field.startsWith('__')) tmp[field] = v
      else if (field === 'order_date') o[field] = toISO(v) ?? null
      else o[field] = v
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
    if (!o.external_id) { LOG('detail: no order number found — DOM may differ'); return null }
    return o
  }

  // ── Drive it ───────────────────────────────────────────────────────────────
  function pageType() {
    const u = location.href
    if (/orderdetails/i.test(u)) return 'detail'
    if (/orderlist/i.test(u)) return 'list'
    return null
  }

  /** Post scraped orders to the background → Castle Admin ingest. Resolves with
   *  the ingest result (incl. needDetail), or null on error. */
  function ingest(kind, payload) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'genie', kind, vendor: VENDOR, payload }, (res) => {
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

  async function waitForRows(ms = 20000) {
    const start = Date.now()
    while (Date.now() - start < ms) { if (scrapeListPage().length) return true; await sleep(500) }
    return false
  }

  /** On the list page mid-sweep: find the next queued order (paging to it if
   *  needed) and click into its detail. Drops an order it can't locate. */
  async function resumeSweepOnList() {
    const sweep = await getSweep()
    if (!sweep || !sweep.queue.length) { await clearSweep(); return }
    const id = sweep.queue[0]
    LOG(`detail sweep: locating #${id} (${sweep.queue.length} left)`)
    await waitForRows()
    let link = findOrderLink(id), pages = 0
    while (!link && pages < MAX_PAGES) {
      const next = findNextPager(); if (!next) break
      const prev = pageSig(); next.click()
      if (!(await waitForPageChange(prev))) break
      link = findOrderLink(id); pages++
    }
    if (!link) {
      LOG(`detail sweep: could not find #${id} — skipping`)
      await setSweep({ ...sweep, queue: sweep.queue.slice(1) })
      return resumeSweepOnList()
    }
    link.click() // navigates to the detail page; the detail branch takes over
  }

  async function runList() {
    // Mid-sweep: don't re-scrape the whole list, just advance the sweep.
    const active = await getSweep()
    if (active && active.queue.length) { await resumeSweepOnList(); return }

    if (!(await waitForRows())) { LOG('list: no rows after waiting — DOM likely differs'); return }
    const orders = AUTO_PAGE ? await scrapeAllListPages() : scrapeListPage()
    LOG(`list: scraped ${orders.length} order(s) across ${AUTO_PAGE ? 'all pages' : 'this page'}`)
    const res = await ingest('list', orders)
    LOG('ingest result', res)

    const cfg = await getCfg()
    if (cfg.genieAutoDetail && res && res.needDetail && res.needDetail.length) {
      const queue = res.needDetail.slice(0, cfg.maxDetailPerRun)
      LOG(`detail sweep: starting ${queue.length} of ${res.needDetail.length} needing detail`)
      await setSweep({ queue, listUrl: location.href })
      await resumeSweepOnList()
    }
  }

  async function runDetail() {
    let tries = 0, o = null
    while (tries++ < 40 && !(o = scrapeDetail())) await sleep(500)
    if (o) { LOG('detail: scraped', o.external_id); await ingest('detail', o) }
    else LOG('detail: nothing scraped — DOM likely differs')

    const sweep = await getSweep()
    if (sweep && sweep.queue.length) {
      const remaining = o ? sweep.queue.filter(x => x !== o.external_id) : sweep.queue.slice(1)
      if (remaining.length) { await setSweep({ ...sweep, queue: remaining }); LOG(`detail sweep: ${remaining.length} left, returning to list`); location.href = sweep.listUrl }
      else { await clearSweep(); LOG('detail sweep: complete') }
    }
  }

  async function main() {
    const type = pageType()
    if (type === 'list') await runList()
    else if (type === 'detail') await runDetail()
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

  LOG('loaded on', location.href, '→', pageType())
  main()
})()
