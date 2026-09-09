import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Queue of Genie appointments for the Chrome extension to write onto existing SF jobs.
//
// Service Fusion's API cannot modify a job that already exists — PUT /jobs/{id} is 405 and
// no update endpoint is documented. Payments (lib/remittance/apply-queue.ts) and IPO line
// items (./sf-lines-queue.ts) hit the same wall and are posted through SF's web session by
// the extension; this mirrors that design so there is one pattern to understand.
//
// The app decides WHAT to write and records what happened. The extension only clicks.

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export interface SfScheduleQueueItem {
  orderId: string
  externalId: string
  sfJobId: string
  jobNumber: string
  customerName: string | null
  /** YYYY-MM-DD */
  date: string
  /** HH:MM, or null for "any time — tech will call ahead". */
  windowStart: string | null
  windowEnd: string | null
}

/** What the extension should write next. Everything it needs is in the payload. Orders
 *  without a job NUMBER are left out: SF's global search needs the number to find the edit
 *  page, and the id alone cannot get us there. */
export async function getSfScheduleQueue(limit = 25): Promise<{ items: SfScheduleQueueItem[] }> {
  const supabase = db()
  const { data, error } = await supabase
    .from('vendor_orders')
    .select('id, external_id, customer_name, sf_job_id, sf_created_job_number, sf_schedule_job_number, appointment_date, appointment_window_start, appointment_window_end')
    .eq('sf_schedule_status', 'queued')
    .not('sf_job_id', 'is', null)
    .not('appointment_date', 'is', null)
    .order('scheduled_at', { ascending: true })
    .limit(limit)
  if (error) { console.error('[sf-schedule-queue] read:', error.message); return { items: [] } }

  const items: SfScheduleQueueItem[] = []
  for (const o of (data ?? []) as Array<Record<string, string | null>>) {
    const jobNumber = o.sf_schedule_job_number ?? o.sf_created_job_number ?? await jobNumberFor(supabase, o.sf_job_id as string)
    if (!jobNumber) {
      await supabase.from('vendor_orders').update({ sf_schedule_status: 'failed', sf_schedule_sync_note: `no SF job number known for job id ${o.sf_job_id}` }).eq('id', o.id as string)
      continue
    }
    items.push({
      orderId: o.id as string,
      externalId: o.external_id as string,
      sfJobId: o.sf_job_id as string,
      jobNumber,
      customerName: o.customer_name ?? null,
      date: o.appointment_date as string,
      windowStart: o.appointment_window_start ?? null,
      windowEnd: o.appointment_window_end ?? null,
    })
  }
  return { items }
}

async function jobNumberFor(supabase: SupabaseClient, sfJobId: string): Promise<string | null> {
  const { data } = await supabase.from('sf_jobs').select('number').eq('id', sfJobId).maybeSingle()
  return (data?.number as string | null) ?? null
}

/** Extension callback: what happened when it wrote one order's appointment. Idempotent — an
 *  order already marked posted stays posted, so a repeat cannot flip success to failure. */
export async function recordSfScheduleResult(
  orderId: string, result: { ok: boolean; error?: string },
): Promise<{ ok: boolean; error?: string }> {
  const supabase = db()
  const { data: guard } = await supabase.from('vendor_orders').select('sf_schedule_status').eq('id', orderId).maybeSingle()
  if (!guard) return { ok: false, error: 'order not found' }
  if (guard.sf_schedule_status === 'posted') return { ok: true }

  await supabase.from('vendor_orders').update(
    result.ok
      ? { sf_schedule_status: 'posted', sf_schedule_synced_at: new Date().toISOString(), sf_schedule_sync_note: 'appointment written to the SF job by the extension' }
      : { sf_schedule_status: 'failed', sf_schedule_sync_note: result.error ?? 'unknown error' },
  ).eq('id', orderId)
  if (result.ok) {
    await supabase.from('vendor_order_events').insert({ order_id: orderId, event_type: 'sf_schedule_synced', to_value: 'posted', detail: {} })
  }
  return { ok: true }
}
