// Talks to the Castle Admin server (the queue + callback). CORS is open on those
// endpoints, so no host permission is needed for the admin origin.

export async function fetchQueue(baseUrl, token) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/remittance/apply-queue`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`queue ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json() // { items: [...], skipped: [...] }
}

export async function postResult(baseUrl, token, payload) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/remittance/apply-callback`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`callback ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

// ── SF job notes (customer-facing-action audit trail) ───────────────────────

export async function fetchNoteQueue(baseUrl, token) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/sf-notes/queue`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`note queue ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json() // { items: [...] }
}

export async function postNoteResult(baseUrl, token, payload) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/sf-notes/callback`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`note callback ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

// ── Clopay IPO line items → SF jobs ─────────────────────────────────────────
//
// Service Fusion's API cannot modify a job that already exists (PUT /jobs → 405), so the app
// queues the line items and the extension posts them through SF's web session — the same
// arrangement as remittance payments above.

export async function fetchLinesQueue(baseUrl, token) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/vendor-orders/sf-lines-queue`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`lines queue ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json() // { items: [{ orderId, sfJobId, jobNumber, lines: [...] }] }
}

export async function postLinesResult(baseUrl, token, payload) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/vendor-orders/sf-lines-callback`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`lines callback ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

// ── Vendor portal orders (Genie / Home Depot, etc.) ─────────────────────────

export async function postVendorOrders(baseUrl, token, vendor, orders, { kind, mode } = {}) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/vendor-orders/ingest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ vendor, orders, kind, mode }),
  })
  if (!res.ok) throw new Error(`ingest ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json() // { inserted, updated, statusChanges, needDetail: [...] }
}

// Report an automation problem (site logged out, crawl/post failed) → Castle
// Admin emails the chosen recipients (deduped). source: 'service_fusion'|'genie'|…
export async function postAlert(baseUrl, token, { source, kind, detail }) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/ops/alert`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, kind, detail }),
  })
  if (!res.ok) throw new Error(`alert ${res.status}: ${(await res.text()).slice(0, 160)}`)
  return res.json()
}
