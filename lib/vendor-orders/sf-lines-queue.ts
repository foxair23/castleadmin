import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { sfGet } from '@/lib/crm/service-fusion'
import { loadIpoLines, toSfServices } from './ipo-services'

// Queue of IPO line items for the Chrome extension to post onto existing SF jobs.
//
// Service Fusion's API cannot modify a job that already exists — PUT /jobs is 405 and no
// update endpoint is documented. The remittance flow hit this same wall and solved it by
// posting through SF's web session from the extension (lib/remittance/apply-queue.ts); this
// mirrors that design deliberately, so there is one pattern to understand rather than two.
//
// The app decides WHAT to post and WHETHER it is safe to. The extension only clicks.

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export interface QueuedLine { code: string; description: string; quantity: number; rate: number }
export interface SfLinesQueueItem {
  orderId: string
  externalId: string
  sfJobId: string
  jobNumber: string | null
  customerName: string | null
  lines: QueuedLine[]
}

/** Services already on the job, read LIVE. GET still works — it is only writes the API
 *  refuses — so the safety check does not depend on the hourly sf_job_items mirror, which
 *  could be describing a job as it was an hour ago. */
async function liveServiceCount(jobId: string): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j = (await sfGet(`/jobs/${encodeURIComponent(jobId)}`)) as any
  const job = j?.items?.[0] ?? j
  const services = Array.isArray(job?.services) ? job.services : []
  const products = Array.isArray(job?.products) ? job.products : []
  return services.length + products.length
}

export interface EnqueueResult {
  ok: boolean
  status: 'queued' | 'already_has_lines' | 'nothing_to_add' | 'no_job' | 'error'
  lines?: number
  existing?: number
  note?: string
  error?: string
}

/** Mark one order's lines ready for the extension. Refuses when the job already carries
 *  line items — those are somebody's hand-entered work and this never competes with it. */
export async function enqueueSfJobLines(orderId: string): Promise<EnqueueResult> {
  const supabase = db()
  try {
    const { data: self } = await supabase
      .from('vendor_orders')
      .select('id, parent_order_id, sf_job_id, external_id')
      .eq('id', orderId).maybeSingle()
    if (!self) return { ok: false, status: 'error', error: 'order not found' }

    const rootId = (self.parent_order_id as string | null) ?? (self.id as string)
    const { data: rows } = await supabase
      .from('vendor_orders')
      .select('id, customer_po, sf_job_id')
      .or(`id.eq.${rootId},parent_order_id.eq.${rootId}`)
    const doors = (rows ?? []) as Array<{ id: string; customer_po: string | null; sf_job_id: string | null }>
    const jobId = doors.map(d => d.sf_job_id).find(Boolean) ?? null
    if (!jobId) return { ok: false, status: 'no_job', note: 'no SF job on this order yet' }

    const services = toSfServices(
      await loadIpoLines(supabase, doors.map(d => d.id)),
      new Map(doors.map(d => [d.id, d.customer_po])),
    )
    if (!services.length) {
      await stamp(supabase, rootId, 'skipped', 'no IPO line items with revenue')
      return { ok: true, status: 'nothing_to_add', lines: 0, note: 'no IPO line items with revenue' }
    }

    const existing = await liveServiceCount(jobId)
    if (existing > 0) {
      const note = `job already has ${existing} line item(s) — not touching it`
      await stamp(supabase, rootId, 'skipped', note)
      return { ok: true, status: 'already_has_lines', existing, lines: 0, note }
    }

    const note = `${services.length} line item(s) queued for the extension`
    await stamp(supabase, rootId, 'queued', note)
    return { ok: true, status: 'queued', lines: services.length, note }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    console.error(`[sf-lines-queue] enqueue ${orderId}: ${error}`)
    return { ok: false, status: 'error', error }
  }
}

async function stamp(supabase: SupabaseClient, orderId: string, status: string, note: string) {
  await supabase.from('vendor_orders')
    .update({ sf_lines_status: status, sf_lines_sync_note: note, sf_lines_synced_at: status === 'posted' ? new Date().toISOString() : null })
    .eq('id', orderId)
}

/** What the extension should post next. Everything it needs is in the payload — it does not
 *  read our database or decide anything. */
export async function getSfLinesQueue(limit = 25): Promise<{ items: SfLinesQueueItem[] }> {
  const supabase = db()
  const { data, error } = await supabase
    .from('vendor_orders')
    .select('id, external_id, customer_name, customer_po, sf_job_id, sf_created_job_number')
    .eq('vendor', 'clopay_hd')
    .eq('sf_lines_status', 'queued')
    .not('sf_job_id', 'is', null)
    .limit(limit)
  if (error) { console.error('[sf-lines-queue] read:', error.message); return { items: [] } }

  const items: SfLinesQueueItem[] = []
  for (const o of (data ?? []) as Array<Record<string, string | null>>) {
    const orderId = o.id as string
    const { data: kids } = await supabase.from('vendor_orders').select('id, customer_po').eq('parent_order_id', orderId)
    const doors = [{ id: orderId, customer_po: o.customer_po ?? null }, ...((kids ?? []) as Array<{ id: string; customer_po: string | null }>)]
    const services = toSfServices(
      await loadIpoLines(supabase, doors.map(d => d.id)),
      new Map(doors.map(d => [d.id, d.customer_po])),
    )
    if (!services.length) continue
    items.push({
      orderId,
      externalId: o.external_id as string,
      sfJobId: o.sf_job_id as string,
      jobNumber: o.sf_created_job_number ?? null,
      customerName: o.customer_name ?? null,
      lines: services.map(s => ({ code: s.service, description: s.description ?? '', quantity: s.multiplier, rate: s.rate })),
    })
  }
  return { items }
}

/** Extension callback: what happened when it posted one order's lines. */
export async function recordSfLinesResult(
  orderId: string, result: { ok: boolean; posted?: number; error?: string },
): Promise<{ ok: boolean; error?: string }> {
  const supabase = db()
  const { data: guard } = await supabase.from('vendor_orders').select('sf_lines_status').eq('id', orderId).maybeSingle()
  if (!guard) return { ok: false, error: 'order not found' }
  if (guard.sf_lines_status === 'posted') return { ok: true } // idempotent — already recorded

  await supabase.from('vendor_orders').update(
    result.ok
      ? { sf_lines_status: 'posted', sf_lines_synced_at: new Date().toISOString(), sf_lines_sync_note: `posted ${result.posted ?? 0} line item(s)` }
      : { sf_lines_status: 'failed', sf_lines_sync_note: result.error ?? 'unknown error' },
  ).eq('id', orderId)
  return { ok: true }
}
