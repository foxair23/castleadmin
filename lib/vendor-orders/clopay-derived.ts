// Clopay display dates derived from the captured detail, computed at INGEST time and
// stored on the row (derived_order_date / derived_last_activity_at / has_detail —
// migration 103). They used to be computed per page view, which forced the HD Orders
// list query to select every order's multi-KB `raw` jsonb just to read a few
// timestamps; now the view reads the columns and never touches `raw`.

/** Parse a Clopay timestamp string ("08/20/2026 02:44 PM CST", "06/10/2026") → Date,
 *  dropping the trailing timezone abbreviation and "Not Applicable". Null if unparseable. */
export function parseClopayTs(s: unknown): Date | null {
  if (typeof s !== 'string') return null
  const t = s.replace(/\s+(CST|CDT|EST|EDT|MST|MDT|PST|PDT|UTC|GMT)\b.*$/i, '').trim()
  if (!t || /not applicable/i.test(t)) return null
  const d = new Date(t)
  return isNaN(d.getTime()) ? null : d
}

/** Order Date = the "Order Received" milestone; Last Activity = the most recent
 *  timestamp anywhere in the Summary milestones or the Notes. */
export function clopayDerivedDates(raw: unknown): { orderDate: string | null; lastActivity: string | null } {
  const r = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const summary = Array.isArray(r.summary) ? r.summary as Array<Record<string, unknown>> : []
  const notes = Array.isArray(r.notes) ? r.notes as Array<Record<string, unknown>> : []
  const recv = summary.find(m => /order received/i.test(String(m?.label || '')))
  const orderDate = parseClopayTs(recv?.completed) || parseClopayTs(recv?.posted) || parseClopayTs(recv?.date)
  let last: Date | null = null
  const consider = (v: unknown) => { const d = parseClopayTs(v); if (d && (!last || d > last)) last = d }
  for (const m of summary) { consider(m?.completed); consider(m?.posted) }
  for (const n of notes) { consider(n?.timestamp) }
  return {
    orderDate: orderDate ? orderDate.toISOString().slice(0, 10) : null,
    lastActivity: last ? (last as Date).toISOString() : null,
  }
}
