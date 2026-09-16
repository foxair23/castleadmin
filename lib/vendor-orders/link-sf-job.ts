import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { autoQueueLinesAfterIpo } from './sf-lines-queue'

// Manual link: "HD Orders doesn't see the SF job I already made." The matcher finds jobs by
// PO, name, email and phone; when the office created a job by hand with none of those lining
// up, nothing links them and the order shows "+ Create SF Job" — which would make a duplicate.
// This is the remittance flow's "or Job #" box, for orders: type the number, the house is
// linked, and its IPO line items are queued for the extension straight away.

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

/** An SF job number as typed — with a leading '#', spaces, or copied punctuation stripped.
 *  Null when what is left is not a job number. */
export function normalizeJobNumber(raw: string | null | undefined): string | null {
  const d = (raw ?? '').replace(/\D/g, '')
  return d.length >= 6 && d.length <= 12 ? d : null
}

export interface LinkResult {
  ok: boolean; error?: string; jobNumber?: string; customerName?: string | null; lines?: string
  /** The job is already on another order. The caller confirms, then links again with
   *  allowShared — deliberately two steps, because sharing is usually a mistake. */
  needsConfirm?: boolean
  warnings?: string[]
}

export interface LinkOptions {
  /** Link even though another order already carries this job. Two HD rows really can be one
   *  SF job — a second door ordered separately, or a Genie and a Clopay order for the same
   *  visit — and the office needs to say so without the rows being grouped as one house. */
  allowShared?: boolean
}

export async function linkSfJobToOrder(orderId: string, rawJobNumber: string, opts: LinkOptions = {}): Promise<LinkResult> {
  const number = normalizeJobNumber(rawJobNumber)
  if (!number) return { ok: false, error: 'Enter the SF job number (digits only).' }
  const supabase = db()

  const { data: job } = await supabase.from('sf_jobs').select('id, number, customer_name').eq('number', number).eq('is_deleted', false).maybeSingle()
  if (!job) return { ok: false, error: `No job #${number} in Service Fusion (the mirror syncs every few minutes — a brand-new job may not be there yet).` }

  const { data: self } = await supabase.from('vendor_orders').select('id, parent_order_id, vendor, external_id').eq('id', orderId).maybeSingle()
  if (!self) return { ok: false, error: 'Order not found.' }
  const rootId = (self.parent_order_id as string | null) ?? (self.id as string)

  // A house is one job. If any door already carries one, say which rather than overwrite it.
  const { data: doors } = await supabase.from('vendor_orders').select('id, sf_job_id, sf_created_job_number').or(`id.eq.${rootId},parent_order_id.eq.${rootId}`)
  const taken = ((doors ?? []) as Array<{ sf_job_id: string | null; sf_created_job_number: string | null }>).find(d => d.sf_job_id || d.sf_created_job_number)
  if (taken && taken.sf_job_id !== job.id) {
    return { ok: false, error: `This house is already linked to SF job #${taken.sf_created_job_number ?? taken.sf_job_id}. Press Unmatch on it first if that is wrong.` }
  }
  // Another order already carries this job. Not an error — two rows can genuinely be one SF
  // job — but it is worth one confirmation, because far more often it means the wrong number
  // was typed.
  const { data: other } = await supabase.from('vendor_orders').select('id, external_id').eq('sf_job_id', job.id).neq('id', rootId).limit(1).maybeSingle()
  if (other && !opts.allowShared) {
    return { ok: false, needsConfirm: true, jobNumber: number, customerName: job.customer_name as string | null,
      error: `SF job #${number} is already linked to order ${other.external_id}. Link this order to it as well?` }
  }

  const now = new Date().toISOString()
  const { error } = await supabase.from('vendor_orders').update({ sf_job_id: job.id, updated_at: now }).eq('id', rootId)
  if (error) return { ok: false, error: error.message }
  // Typing the number is the office overruling an earlier Unmatch of this same job.
  const { data: excl } = await supabase.from('vendor_orders').select('id, sf_match_excluded_job_ids').or(`id.eq.${rootId},parent_order_id.eq.${rootId}`).contains('sf_match_excluded_job_ids', [job.id])
  for (const r of (excl ?? []) as Array<{ id: string; sf_match_excluded_job_ids: string[] }>) {
    await supabase.from('vendor_orders').update({ sf_match_excluded_job_ids: r.sf_match_excluded_job_ids.filter(x => x !== job.id) }).eq('id', r.id)
  }
  await supabase.from('vendor_order_events').insert({
    order_id: rootId, event_type: 'sf_job_linked', to_value: job.number,
    detail: { sf_job_id: job.id, method: 'manual', typed: rawJobNumber, shared_with_order_id: other?.id ?? null },
  })

  // The reason anyone links a job by hand is to get the IPO lines onto it. Queue them now —
  // same guards as everywhere else: live check, never a job that already carries lines.
  let lines = 'no IPO line items to add yet'
  try {
    const q = await autoQueueLinesAfterIpo([rootId])
    if (q.queued) lines = 'IPO line items queued for the extension'
    else if (q.skipped) lines = 'IPO line items not queued (already posted, or the job already carries lines)'
  } catch { /* the link itself succeeded; the button remains */ }

  const warnings: string[] = []
  if (other) {
    // Everything that writes into SF is per-order, so a shared job can be written to twice.
    // The line queue's live check stops a second post of the items; nothing stops a second
    // appointment or a second e-sign form, so the office is told to expect one of each.
    warnings.push(`Also linked to order ${other.external_id} — both rows now show job #${job.number}.`)
    warnings.push('Send the appointment and the e-sign form from one row only; the job takes line items once.')
  }
  return { ok: true, jobNumber: job.number as string, customerName: job.customer_name as string | null, lines, warnings }
}
