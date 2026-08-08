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

// ── Vendor portal orders (Genie / Home Depot, etc.) ─────────────────────────

export async function postVendorOrders(baseUrl, token, vendor, orders) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/vendor-orders/ingest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ vendor, orders }),
  })
  if (!res.ok) throw new Error(`ingest ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json() // { inserted, updated, statusChanges, needDetail: [...] }
}
