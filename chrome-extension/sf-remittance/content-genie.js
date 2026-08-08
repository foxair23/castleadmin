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
  const LOG = (...a) => console.log('[genie]', ...a)
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
  const STATUS_RE = /^(open|clos|cancel|complet|pend|schedul|hold)/i

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
      if (!STATUS_RE.test(cells[0] || '')) continue // data rows start with a status word
      const o = {}
      cells.forEach((val, i) => {
        const c = colMap[i]
        if (!c || !c.field) return
        o[c.field] = c.iso ? (toISO(val) ?? null) : (norm(val) || null)
      })
      if (o.external_id) out.push(o)
    }
    return out
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

  function send(kind, payload) {
    chrome.runtime.sendMessage({ type: 'genie', kind, vendor: VENDOR, payload }, (res) => {
      if (chrome.runtime.lastError) { LOG('send error', chrome.runtime.lastError.message); return }
      LOG('ingest result', res)
    })
  }

  // ADF renders asynchronously; wait for content to settle, then scrape once.
  function waitAndRun() {
    const type = pageType()
    if (!type) return
    let tries = 0
    const timer = setInterval(() => {
      tries++
      if (type === 'list') {
        const orders = scrapeListPage()
        if (orders.length) { clearInterval(timer); LOG(`list: scraped ${orders.length} on this page`); send('list', orders) }
      } else {
        const o = scrapeDetail()
        if (o) { clearInterval(timer); LOG('detail: scraped', o.external_id); send('detail', o) }
      }
      if (tries > 40) { clearInterval(timer); LOG(`${type}: nothing scraped after waiting — DOM likely differs, check selectors`) }
    }, 500)
  }

  // Manual re-scrape from the popup ("Scrape this page now").
  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg?.type === 'genie-rescrape') {
      const type = pageType()
      if (type === 'list') { const o = scrapeListPage(); send('list', o); reply({ ok: true, type, count: o.length }) }
      else if (type === 'detail') { const o = scrapeDetail(); if (o) send('detail', o); reply({ ok: !!o, type }) }
      else reply({ ok: false, error: 'not a Genie order page' })
      return true
    }
  })

  LOG('loaded on', location.href, '→', pageType())
  waitAndRun()
})()
