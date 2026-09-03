import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Genie Action Items tab: one row per SF job our service created from a Genie
// order, until someone presses "Done". Mirrors the SFI Leads tab's treatment.

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export interface GenieActionItem {
  id: string
  external_id: string          // Home Depot order #
  customer_name: string | null
  sf_job_number: string | null // number captured at creation
  address: string | null
  order_date: string | null
  status: string | null
  phone: string | null
  created_job_at: string
  // Customer self-scheduling: set once the customer books via the Genie
  // scheduler. Null ⇒ nobody has scheduled it yet, so a rep can book on their
  // behalf.
  appointment_date: string | null
  appointment_window_start: string | null
  appointment_window_end: string | null
  // When the one-time "please schedule" nudge (email/SMS) went out. Null ⇒ not
  // yet sent.
  schedule_nudge_sent_at: string | null
}
export interface GenieActionItemsResult { items: GenieActionItem[] }

// The Clopay tab carries TWO kinds of work, both "someone needs to schedule this":
//   'new_job' — an SF job WE created from a Clopay order, not yet scheduled. Button: "New
//               Job to Schedule". Clopay orders don't self-schedule or get nudges, so the
//               appointment/nudge fields are simply null.
//   'at_dc'   — product has physically arrived at the DC and is ready for install. Button:
//               "Schedule Install/Delivery". Sourced from the weekly DC report, keyed by PO.
// They dismiss to different places (see markClopayActionDone), so the kind travels with the
// item rather than being inferred in the UI.
export interface ClopayActionItem extends GenieActionItem {
  kind: 'new_job' | 'at_dc'
  /** at_dc only — the PO is the unit of work, and one customer can have one PO at the DC
   *  while another has not arrived. */
  po?: string | null
  reserved_date?: string | null
  days_at_dc?: number | null
  /** at_dc only — true when the DC report names an order we have no record of at all (the
   *  Castle-direct orders, Clopay customer 61232, which reach no other system). */
  unknown_order?: boolean
}
export interface ClopayActionItemsResult { items: ClopayActionItem[] }

/** Created-but-not-yet-handled SF jobs our service made for a vendor's orders (the
 *  `sf_created_job_number` marker, set only on create), until someone presses Done. */
async function getCreatedJobItems(vendor: string): Promise<GenieActionItemsResult> {
  const { data } = await db()
    .from('vendor_orders')
    .select('id, external_id, customer_name, sf_created_job_number, street_address, city, state_prov, postal_code, order_date, status, phone, updated_at, appointment_date, appointment_window_start, appointment_window_end, schedule_nudge_sent_at')
    .eq('vendor', vendor)
    .not('sf_created_job_number', 'is', null)
    .is('action_done_at', null)
    .order('updated_at', { ascending: false })
    .limit(500)
  const items = ((data ?? []) as Array<Record<string, string | null>>).map(o => ({
    id: o.id as string,
    external_id: o.external_id as string,
    customer_name: o.customer_name,
    sf_job_number: o.sf_created_job_number,
    address: [o.street_address, o.city, o.state_prov, o.postal_code].filter(Boolean).join(', ') || null,
    order_date: o.order_date,
    status: o.status,
    phone: o.phone,
    created_job_at: (o.updated_at as string) ?? '',
    appointment_date: o.appointment_date,
    appointment_window_start: o.appointment_window_start,
    appointment_window_end: o.appointment_window_end,
    schedule_nudge_sent_at: o.schedule_nudge_sent_at,
  }))
  return { items }
}

/** Created-but-not-yet-handled Genie SF jobs. */
export function getGenieActionItems(): Promise<GenieActionItemsResult> {
  return getCreatedJobItems('genie_thd')
}

/** The Clopay tab: SF jobs we created that still need scheduling, plus orders whose product
 *  has landed at the DC ready for install. Oldest DC arrivals first — a PO that has been
 *  sitting for months is the one worth calling out. */
export async function getClopayActionItems(): Promise<ClopayActionItemsResult> {
  const [jobs, dc] = await Promise.all([getCreatedJobItems('clopay_hd'), getDcActionItems()])
  const jobItems: ClopayActionItem[] = jobs.items.map(i => ({ ...i, kind: 'new_job' as const }))
  return { items: [...jobItems, ...dc] }
}

/** POs on the weekly DC report that nobody has scheduled yet. A PO reappears on every report
 *  until its product physically leaves the DC, so `scheduled_at` — set once, never cleared —
 *  is what stops a handled PO coming back week after week. */
async function getDcActionItems(): Promise<ClopayActionItem[]> {
  const { data } = await db()
    .from('clopay_dc_po_state')
    .select('po_key, order_no, po, kind, reserved_date, order_id')
    .is('scheduled_at', null)
    .order('reserved_date', { ascending: true, nullsFirst: false })
    .limit(500)
  const rows = (data ?? []) as Array<{ po_key: string; order_no: string; po: string | null; kind: string; reserved_date: string | null; order_id: string | null }>
  if (!rows.length) return []

  // Pull what we know about the linked orders so the item reads like the rest of the tab.
  const ids = [...new Set(rows.map(r => r.order_id).filter((v): v is string => !!v))]
  const { data: orders } = ids.length
    ? await db().from('vendor_orders')
        .select('id, customer_name, street_address, city, state_prov, postal_code, order_date, status, phone, sf_created_job_number, appointment_date, appointment_window_start, appointment_window_end')
        .in('id', ids)
    : { data: [] }
  const byId = new Map(((orders ?? []) as Array<Record<string, string | null>>).map(o => [o.id as string, o]))

  const today = new Date()
  return rows.map(r => {
    const o = r.order_id ? byId.get(r.order_id) : undefined
    const days = r.reserved_date
      ? Math.floor((today.getTime() - new Date(`${r.reserved_date}T00:00:00Z`).getTime()) / 86400000)
      : null
    return {
      // The id IS the PO key: an at_dc item dismisses against clopay_dc_po_state, and a
      // Castle-direct row has no vendor_orders row to point at.
      id: r.po_key,
      kind: 'at_dc' as const,
      external_id: r.order_no,
      customer_name: o?.customer_name ?? null,
      sf_job_number: o?.sf_created_job_number ?? null,
      address: o ? ([o.street_address, o.city, o.state_prov, o.postal_code].filter(Boolean).join(', ') || null) : null,
      order_date: o?.order_date ?? null,
      status: o?.status ?? null,
      phone: o?.phone ?? null,
      created_job_at: '',
      // Shown so a dispatcher can clear an already-booked PO fast — some sit at the DC for
      // weeks because the customer asked us to wait.
      appointment_date: o?.appointment_date ?? null,
      appointment_window_start: o?.appointment_window_start ?? null,
      appointment_window_end: o?.appointment_window_end ?? null,
      schedule_nudge_sent_at: null,
      po: r.po,
      reserved_date: r.reserved_date,
      days_at_dc: days,
      unknown_order: !r.order_id,
    }
  })
}

/** Mark a Genie/Clopay action-item row Done (clears it from the tab). */
export async function markGenieActionDone(id: string, byName: string | null): Promise<void> {
  await db().from('vendor_orders').update({ action_done_at: new Date().toISOString(), action_done_by: byName }).eq('id', id)
}

/** Dismiss a DC arrival: the PO has been scheduled. Permanent — the PO keeps appearing on
 *  every weekly report until its product leaves the DC, and must not resurface. */
export async function markDcPoScheduled(poKey: string, byName: string | null): Promise<void> {
  await db().from('clopay_dc_po_state')
    .update({ scheduled_at: new Date().toISOString(), scheduled_by: byName })
    .eq('po_key', poKey)
}

// ── Clopay STS ──────────────────────────────────────────────────────────────

export interface StsActionItem {
  id: string
  external_id: string           // Clopay order #
  customer_po: string | null
  status: string
  details_requested_at: string | null
  details_received_at: string | null
  first_seen_at: string
}
export interface StsActionItemsResult { items: StsActionItem[] }

const STS_CLOSED_STAGE = 'Closed (invoiced/billed)'

/** Open STS orders (status ≠ Closed) — the office works these through the pipeline. */
export async function getStsActionItems(): Promise<StsActionItemsResult> {
  const { data } = await db()
    .from('vendor_orders')
    .select('id, external_id, customer_po, status, details_requested_at, details_received_at, first_seen_at')
    .eq('vendor', 'clopay_sts')
    .neq('status', STS_CLOSED_STAGE)
    .order('first_seen_at', { ascending: false })
    .limit(500)
  const items = ((data ?? []) as Array<Record<string, string | null>>).map(o => ({
    id: o.id as string,
    external_id: o.external_id as string,
    customer_po: o.customer_po,
    status: (o.status as string) ?? 'Received',
    details_requested_at: o.details_requested_at,
    details_received_at: o.details_received_at,
    first_seen_at: (o.first_seen_at as string) ?? '',
  }))
  return { items }
}
