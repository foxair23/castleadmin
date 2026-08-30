import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getVendor, type VendorOrderFields } from './config'
import { clopayDerivedDates } from './clopay-derived'

// Ingest scraped vendor-portal orders into the shared log. The extension scrapes
// the orders grid (list-level fields for every order) and, for orders we don't
// yet have detail on, opens each order's detail page and scrapes the rest. Both
// arrive here. We upsert by (vendor, external_id), record what changed as
// events, and tell the extension which orders still need their detail scraped.
//
// Idempotent + merge-friendly: list fields always refresh; detail fields only
// overwrite when the payload actually includes them (a list-only scrape never
// wipes previously-captured detail).

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

/** One scraped order. All fields optional except external_id; `hasDetail` marks
 *  that the detail-page fields in this payload are authoritative. */
export interface ScrapedOrder extends Partial<VendorOrderFields> {
  external_id: string
  hasDetail?: boolean
  raw?: Record<string, unknown>
}

// Fields refreshed on every scrape (list or detail) when present in the payload.
// Address/city/state/zip live here — some portals (Clopay HD) surface them in the
// order LIST, so they should store without waiting for a detail sweep. Portals
// whose list lacks them (Genie) simply don't include those keys in a list
// payload, so nothing changes for them; their detail scrape still fills them.
const LIST_FIELDS = ['status', 'next_step', 'order_type', 'customer_name', 'customer_po', 'store_number', 'order_date', 'schedule_date', 'street_address', 'city', 'state_prov', 'postal_code'] as const
// Fields only a detail page provides — written only when the payload is a detail
// scrape (hasDetail), which is also what stamps detail_scraped_at.
const DETAIL_FIELDS = ['phone', 'email', 'scope'] as const

/** Empty strings from a scrape become null; trims whitespace. */
function clean(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' || s === '-' ? null : s
}

/** Whether a stored `raw` actually carries detail-page content (Summary text /
 *  milestones, Notes, or Documents). We key "still needs detail" off this rather
 *  than `detail_scraped_at` alone: an order the crawler opened but scraped EMPTY
 *  (e.g. the earlier panel-text bug) has detail_scraped_at set yet no real
 *  content, and must be re-detailed on the next backfill. Mirrors the drawer's
 *  hasDrawer() check on the client. */
function hasStoredDetail(raw: Record<string, unknown> | null | undefined): boolean {
  if (!raw || typeof raw !== 'object') return false
  const st = (raw as { summary_text?: unknown }).summary_text
  if (typeof st === 'string' && st.trim().length > 0) return true
  const summary = (raw as { summary?: unknown }).summary
  if (Array.isArray(summary) && summary.length > 0) return true
  const notes = (raw as { notes?: unknown }).notes
  if (Array.isArray(notes) && notes.length > 0) return true
  const docs = (raw as { documents?: unknown }).documents
  if (Array.isArray(docs) && docs.length > 0) return true
  return false
}

export interface IngestResult {
  ok: boolean
  vendor: string
  received: number
  inserted: number
  updated: number
  statusChanges: number
  /** external_ids the extension should open + scrape detail for (new, or still
   *  missing detail). */
  needDetail: string[]
  error?: string
}

export interface IngestMeta { kind?: 'list' | 'detail'; mode?: string | null }

export async function ingestOrders(vendor: string, orders: ScrapedOrder[], meta: IngestMeta = {}): Promise<IngestResult> {
  const base = { ok: false, vendor, received: orders?.length ?? 0, inserted: 0, updated: 0, statusChanges: 0, needDetail: [] as string[] }
  if (!getVendor(vendor)) return { ...base, error: `unknown vendor '${vendor}'` }
  if (!Array.isArray(orders) || orders.length === 0) return { ...base, ok: true }

  const supabase = db()
  const ids = [...new Set(orders.map(o => o.external_id).filter(Boolean))]

  // Existing rows for this vendor's incoming ids. `raw` is included so we can
  // MERGE the incoming raw into it rather than replace — the list scrape and the
  // detail scrape each carry different raw keys, and replacing would wipe the
  // other's (e.g. a later list scrape erasing the captured Summary/Documents/Notes).
  const { data: existingRows } = await supabase
    .from('vendor_orders')
    .select('id, external_id, status, next_step, detail_scraped_at, raw')
    .eq('vendor', vendor)
    .in('external_id', ids.length ? ids : ['__none__'])
  const existing = new Map((existingRows ?? []).map((r: { id: string; external_id: string; status: string | null; next_step: string | null; detail_scraped_at: string | null; raw: Record<string, unknown> | null }) => [r.external_id, r]))

  const now = new Date().toISOString()
  let inserted = 0, updated = 0, statusChanges = 0
  const events: Array<{ order_id: string; event_type: string; from_value?: string | null; to_value?: string | null }> = []
  const needDetail: string[] = []

  for (const o of orders) {
    if (!o.external_id) continue
    const prior = existing.get(o.external_id)

    // Build the update from whatever fields this payload carries.
    const row: Record<string, unknown> = { vendor, external_id: o.external_id, last_seen_at: now, updated_at: now }
    for (const f of LIST_FIELDS) if (f in o) row[f] = clean(o[f])
    if (o.hasDetail) {
      for (const f of DETAIL_FIELDS) if (f in o) row[f] = clean(o[f])
      row.detail_scraped_at = now
    }
    // Merge raw so list-scrape keys and detail-scrape keys accumulate instead of
    // clobbering each other.
    if (o.raw) row.raw = prior ? { ...(prior.raw ?? {}), ...o.raw } : o.raw

    // Clopay display fields derived from the merged raw, stored as columns so the HD
    // Orders list never has to select `raw` (migration 103; SQL backfill covered
    // pre-existing rows, this keeps them current).
    if (vendor === 'clopay_hd' && row.raw) {
      const merged = row.raw as Record<string, unknown>
      const der = clopayDerivedDates(merged)
      if (der.orderDate) row.derived_order_date = der.orderDate
      if (der.lastActivity) row.derived_last_activity_at = der.lastActivity
      row.has_detail = hasStoredDetail(merged)
    }

    if (!prior) {
      row.first_seen_at = now
      const { data: ins } = await supabase.from('vendor_orders').insert(row).select('id').maybeSingle()
      inserted++
      if (ins?.id) {
        events.push({ order_id: ins.id, event_type: 'seen', to_value: clean(o.status) })
        if (o.hasDetail) events.push({ order_id: ins.id, event_type: 'detail_scraped' })
      }
      if (!o.hasDetail) needDetail.push(o.external_id) // brand new → get its detail
    } else {
      await supabase.from('vendor_orders').update(row).eq('id', prior.id)
      updated++
      const newStatus = 'status' in o ? clean(o.status) : prior.status
      const newNext = 'next_step' in o ? clean(o.next_step) : prior.next_step
      const statusChanged = newStatus !== prior.status
      if (statusChanged) { statusChanges++; events.push({ order_id: prior.id, event_type: 'status_change', from_value: prior.status, to_value: newStatus }) }
      if (newNext !== prior.next_step) events.push({ order_id: prior.id, event_type: 'next_step_change', from_value: prior.next_step, to_value: newNext })
      if (o.hasDetail && !prior.detail_scraped_at) events.push({ order_id: prior.id, event_type: 'detail_scraped' })
      // "Still needs detail" when: (a) the merged raw has no real detail content yet
      // (new/empty), OR (b) the STATUS just changed — a status change is when Clopay
      // adds new milestones/notes/documents, so re-detail to pick them up. Using the
      // stored content (not just detail_scraped_at) also lets a backfill re-queue
      // orders that were captured empty and skip ones already indexed.
      const mergedRaw = (row.raw ?? prior.raw) as Record<string, unknown> | null
      if (!o.hasDetail && (!hasStoredDetail(mergedRaw) || statusChanged)) needDetail.push(o.external_id)
    }
  }

  if (events.length) await supabase.from('vendor_order_events').insert(events)

  // Record a scrape-run for the health readout. Only for list scrapes — those are
  // the "we read the whole order list" events; per-order detail posts would be noise.
  const kind = meta.kind ?? 'list'
  if (kind === 'list') {
    await supabase.from('vendor_scrape_runs').insert({
      vendor, kind, mode: meta.mode ?? null, received: orders.length, inserted, updated, status_changes: statusChanges,
    })
  }

  return { ok: true, vendor, received: orders.length, inserted, updated, statusChanges, needDetail: [...new Set(needDetail)] }
}
