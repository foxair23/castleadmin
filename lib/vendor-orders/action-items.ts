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

/** Created-but-not-yet-handled Genie SF jobs. */
export async function getGenieActionItems(): Promise<GenieActionItemsResult> {
  const { data } = await db()
    .from('vendor_orders')
    .select('id, external_id, customer_name, sf_created_job_number, street_address, city, state_prov, postal_code, order_date, status, phone, updated_at, appointment_date, appointment_window_start, appointment_window_end, schedule_nudge_sent_at')
    .eq('vendor', 'genie_thd')
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

/** Mark a Genie action-item row Done (clears it from the tab). */
export async function markGenieActionDone(id: string, byName: string | null): Promise<void> {
  await db().from('vendor_orders').update({ action_done_at: new Date().toISOString(), action_done_by: byName }).eq('id', id)
}
