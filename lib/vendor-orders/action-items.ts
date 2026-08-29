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

// The Clopay tab surfaces the same thing (an SF job WE created, awaiting handling) for
// clopay_hd orders — Clopay orders don't self-schedule or get nudges, so the appointment/
// nudge fields are simply null. Same row shape, so reuse it.
export type ClopayActionItem = GenieActionItem
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

/** Created-but-not-yet-handled Clopay HD SF jobs — a dispatcher schedules each, then Done. */
export function getClopayActionItems(): Promise<ClopayActionItemsResult> {
  return getCreatedJobItems('clopay_hd')
}

/** Mark a Genie/Clopay action-item row Done (clears it from the tab). */
export async function markGenieActionDone(id: string, byName: string | null): Promise<void> {
  await db().from('vendor_orders').update({ action_done_at: new Date().toISOString(), action_done_by: byName }).eq('id', id)
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
