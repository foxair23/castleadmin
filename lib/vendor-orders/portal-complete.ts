import type { SupabaseClient } from '@supabase/supabase-js'

// "Has Clopay's portal recorded every step, so they can actually pay us?"
//
// The Unpaid tab chases money. For Clopay HD work, money does not move until the order in
// Clopay's own portal reads "Install/Delivery Completed" — so a job sitting unpaid because
// the portal is still mid-flow is a different problem from one where Clopay simply has not
// paid, and the office was having to check the two screens by hand.
//
// The link is read, never recomputed: a stored decision (a hand link, or a job we created)
// first, then the cached match HD Orders writes down (migration 150). Recomputing here would
// mean scanning every Clopay order and rebuilding the SF job index on a page that already
// does plenty.

export type PortalComplete = 'yes' | 'no' | 'na'

/** Clopay's own rule: ONLY "Install/Delivery Completed" means every step is done. Cancelled
 *  is terminal but not complete — nothing is owed on it — and the other "completed"-ish
 *  statuses ("Completed SC Recvd by Clopay") are mid-flow. */
export function portalCompleteFromStatus(status: string | null | undefined): PortalComplete {
  const k = (status || '').toLowerCase().trim()
  if (!k) return 'no'
  return /install\s*\/?\s*delivery completed/.test(k) ? 'yes' : 'no'
}

interface OrderRow {
  id: string; parent_order_id: string | null; status: string | null
  sf_job_id: string | null; sf_created_job_number: string | null; sf_match_job_number: string | null
}

/** job id → yes / no / n-a, for the jobs given. 'na' means no Clopay order answers to this
 *  job — most unpaid jobs are ordinary Castle work and have nothing to do with the portal. */
export async function portalCompleteByJob(
  db: SupabaseClient,
  jobs: Array<{ id: string; number: string | null }>,
): Promise<Map<string, PortalComplete>> {
  const out = new Map<string, PortalComplete>()
  for (const j of jobs) out.set(j.id, 'na')
  if (!jobs.length) return out

  const ids = jobs.map(j => j.id)
  const numbers = jobs.map(j => j.number).filter((n): n is string => !!n)
  const quoted = (xs: string[]) => `(${xs.map(x => `"${String(x).replace(/"/g, '')}"`).join(',')})`
  // Only the orders that answer to these jobs, by any of the three links.
  const filters = [`sf_job_id.in.${quoted(ids)}`]
  if (numbers.length) filters.push(`sf_created_job_number.in.${quoted(numbers)}`, `sf_match_job_number.in.${quoted(numbers)}`)
  const { data } = await db.from('vendor_orders')
    .select('id, parent_order_id, status, sf_job_id, sf_created_job_number, sf_match_job_number')
    .eq('vendor', 'clopay_hd')
    .or(filters.join(','))
    .limit(1000)
  const rows = (data ?? []) as OrderRow[]
  if (!rows.length) return out

  // A door can carry the link while the house carries the status, so read the parent's.
  const parentIds = [...new Set(rows.map(r => r.parent_order_id).filter((v): v is string => !!v))]
  const parentStatus = new Map<string, string | null>()
  if (parentIds.length) {
    const { data: parents } = await db.from('vendor_orders').select('id, status').in('id', parentIds)
    for (const p of (parents ?? []) as Array<{ id: string; status: string | null }>) parentStatus.set(p.id, p.status)
  }

  const idSet = new Set(ids)
  const numberToId = new Map(jobs.filter(j => j.number).map(j => [String(j.number), j.id]))
  for (const r of rows) {
    const jobId = (r.sf_job_id && idSet.has(r.sf_job_id) ? r.sf_job_id : null)
      ?? numberToId.get(String(r.sf_created_job_number ?? '')) 
      ?? numberToId.get(String(r.sf_match_job_number ?? ''))
    if (!jobId) continue
    const status = r.parent_order_id ? parentStatus.get(r.parent_order_id) ?? r.status : r.status
    // A house already answered "yes" is not undone by a door that says otherwise.
    if (out.get(jobId) === 'yes') continue
    out.set(jobId, portalCompleteFromStatus(status))
  }
  return out
}
