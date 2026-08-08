import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getVendor, type VendorOrderFields } from './config'

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

const LIST_FIELDS = ['status', 'next_step', 'order_type', 'customer_name', 'customer_po', 'store_number', 'order_date', 'schedule_date'] as const
const DETAIL_FIELDS = ['street_address', 'city', 'state_prov', 'postal_code', 'phone', 'email', 'scope'] as const

/** Empty strings from a scrape become null; trims whitespace. */
function clean(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' || s === '-' ? null : s
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

export async function ingestOrders(vendor: string, orders: ScrapedOrder[]): Promise<IngestResult> {
  const base = { ok: false, vendor, received: orders?.length ?? 0, inserted: 0, updated: 0, statusChanges: 0, needDetail: [] as string[] }
  if (!getVendor(vendor)) return { ...base, error: `unknown vendor '${vendor}'` }
  if (!Array.isArray(orders) || orders.length === 0) return { ...base, ok: true }

  const supabase = db()
  const ids = [...new Set(orders.map(o => o.external_id).filter(Boolean))]

  // Existing rows for this vendor's incoming ids.
  const { data: existingRows } = await supabase
    .from('vendor_orders')
    .select('id, external_id, status, next_step, detail_scraped_at')
    .eq('vendor', vendor)
    .in('external_id', ids.length ? ids : ['__none__'])
  const existing = new Map((existingRows ?? []).map((r: { id: string; external_id: string; status: string | null; next_step: string | null; detail_scraped_at: string | null }) => [r.external_id, r]))

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
    if (o.raw) row.raw = o.raw

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
      if (newStatus !== prior.status) { statusChanges++; events.push({ order_id: prior.id, event_type: 'status_change', from_value: prior.status, to_value: newStatus }) }
      if (newNext !== prior.next_step) events.push({ order_id: prior.id, event_type: 'next_step_change', from_value: prior.next_step, to_value: newNext })
      if (o.hasDetail && !prior.detail_scraped_at) events.push({ order_id: prior.id, event_type: 'detail_scraped' })
      if (!prior.detail_scraped_at && !o.hasDetail) needDetail.push(o.external_id) // still missing detail
    }
  }

  if (events.length) await supabase.from('vendor_order_events').insert(events)

  return { ok: true, vendor, received: orders.length, inserted, updated, statusChanges, needDetail: [...new Set(needDetail)] }
}
