import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { resolveSfJobMatches } from './sf-match'

// "Unmatch": the SF Job # column shows the wrong job. Two cases, one button.
//  - A STORED link (sf_job_id, set by a manual link, a matcher-backed queue step, or job
//    creation): cleared on every row of the house.
//  - A COMPUTED match (PO / name / email / phone): nothing to clear — instead the rejected
//    job id is recorded on the house so the matcher never returns it for this order again.
// Both are done every time, so whichever way the wrong job got there, it stays gone. What
// is NOT undone: anything already written INTO Service Fusion (IPO line items, an
// appointment, a signed form) — the result says so, so the office can clean the job by hand.

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export interface UnmatchResult { ok: boolean; error?: string; jobNumber?: string | null; warnings?: string[] }

export async function unmatchSfJobFromOrder(orderId: string, userId?: string | null): Promise<UnmatchResult> {
  const supabase = db()
  const { data: self } = await supabase.from('vendor_orders').select('id, parent_order_id').eq('id', orderId).maybeSingle()
  if (!self) return { ok: false, error: 'Order not found.' }
  const rootId = (self.parent_order_id as string | null) ?? (self.id as string)

  const { data: rows } = await supabase.from('vendor_orders')
    .select('id, external_id, customer_po, customer_name, email, phone, sf_job_id, sf_created_job_number, sf_match_excluded_job_ids, sf_lines_status, sf_schedule_status')
    .or(`id.eq.${rootId},parent_order_id.eq.${rootId}`)
  const house = (rows ?? []) as Array<{
    id: string; external_id: string | null; customer_po: string | null; customer_name: string | null; email: string | null; phone: string | null
    sf_job_id: string | null; sf_created_job_number: string | null; sf_match_excluded_job_ids: string[] | null; sf_lines_status: string | null; sf_schedule_status: string | null
  }>
  const root = house.find(r => r.id === rootId)
  if (!root) return { ok: false, error: 'Order not found.' }

  // Which job is showing right now: the stored link, else what the matcher computes.
  let jobId: string | null = house.map(r => r.sf_job_id).find(Boolean) ?? null
  if (!jobId) {
    const matches = await resolveSfJobMatches(supabase, house)
    jobId = house.map(r => matches.get(r.id)?.sfJobId).find(Boolean) ?? null
  }
  if (!jobId) return { ok: false, error: 'No SF job is matched to this order.' }

  const { data: job } = await supabase.from('sf_jobs').select('id, number').eq('id', jobId).maybeSingle()
  const jobNumber = (job?.number as string | null) ?? null
  // A job Castle Admin created FROM this order is this order's job by construction; unmatching
  // it would let autopilot create a second one for the same house.
  if (jobNumber && house.some(r => r.sf_created_job_number === jobNumber)) {
    return { ok: false, error: `SF job #${jobNumber} was created from this order by Castle Admin, so it cannot be unmatched here. If it is wrong, delete the job in Service Fusion first.` }
  }

  const now = new Date().toISOString()
  const warnings: string[] = []
  for (const r of house) {
    const excluded = Array.from(new Set([...(r.sf_match_excluded_job_ids ?? []), jobId]))
    const patch: Record<string, unknown> = { sf_match_excluded_job_ids: excluded, updated_at: now }
    if (r.sf_job_id === jobId) patch.sf_job_id = null
    // Work still waiting to go onto the wrong job is cancelled; work already posted is not.
    if (r.sf_lines_status === 'queued') { patch.sf_lines_status = null; patch.sf_lines_sync_note = `line items unqueued — job #${jobNumber ?? jobId} unmatched` }
    if (r.sf_schedule_status === 'queued') { patch.sf_schedule_status = null; patch.sf_schedule_sync_note = `appointment unqueued — job #${jobNumber ?? jobId} unmatched` }
    const { error } = await supabase.from('vendor_orders').update(patch).eq('id', r.id)
    if (error) return { ok: false, error: error.message }
    if (r.sf_lines_status === 'posted') warnings.push(`IPO line items were already posted to job #${jobNumber ?? jobId} — remove them in Service Fusion.`)
    if (r.sf_schedule_status === 'posted') warnings.push(`The appointment was already written to job #${jobNumber ?? jobId} in Service Fusion.`)
  }

  // The e-sign form for this house pointed at the same job: forget it so the next sweep
  // re-links (or holds) rather than sending the customer a form for someone else's job.
  const { data: docs } = await supabase.from('esign_documents').select('id, status').eq('order_id', rootId).eq('sf_job_id', jobId)
  for (const d of (docs ?? []) as Array<{ id: string; status: string }>) {
    await supabase.from('esign_documents').update({ sf_job_id: null, updated_at: now }).eq('id', d.id)
    if (['finalized', 'uploaded', 'portal_uploaded'].includes(d.status)) warnings.push(`The signed form was already filed against job #${jobNumber ?? jobId}.`)
  }

  await supabase.from('vendor_order_events').insert({
    order_id: rootId, event_type: 'sf_job_unlinked', from_value: jobNumber ?? jobId, to_value: null,
    detail: { sf_job_id: jobId, method: 'manual', by: userId ?? null },
  })
  return { ok: true, jobNumber, warnings: Array.from(new Set(warnings)) }
}
