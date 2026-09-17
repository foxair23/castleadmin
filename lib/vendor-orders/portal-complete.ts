import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveSfJobMatches } from './sf-match'

// "Has Clopay's portal recorded every step, so they can actually pay us?"
//
// The Unpaid tab chases money. For Clopay HD work, money does not move until the order in
// Clopay's own portal reads "Install/Delivery Completed" — so a job sitting unpaid because
// the portal is still mid-flow is a different problem from one where Clopay simply has not
// paid, and the office was having to check the two screens by hand.
//
// The link between an SF job and a Clopay order is the SAME matcher HD Orders uses, so the
// two screens can never disagree about which order belongs to which job.

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
  sf_job_id: string | null; sf_created_job_number: string | null
  external_id: string | null; customer_po: string | null; additional_pos: string[] | null
  customer_name: string | null; email: string | null; phone: string | null
  sf_match_excluded_job_ids: string[] | null
}

const COLS = 'id, parent_order_id, status, sf_job_id, sf_created_job_number, external_id, customer_po, additional_pos, customer_name, email, phone, sf_match_excluded_job_ids'

/** Every Clopay order, paged past PostgREST's 1000-row cap. */
async function allClopayOrders(db: SupabaseClient): Promise<OrderRow[]> {
  const out: OrderRow[] = []
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('vendor_orders').select(COLS).eq('vendor', 'clopay_hd')
      .order('id', { ascending: true }).range(from, from + 999)
    const rows = (data ?? []) as OrderRow[]
    out.push(...rows)
    if (rows.length < 1000) return out
  }
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

  const orders = await allClopayOrders(db)
  if (!orders.length) return out
  const byId = new Map(orders.map(o => [o.id, o]))
  const roots = orders.filter(o => !o.parent_order_id)
  /** The status shown on the Clopay tab is the HOUSE's — a door recovered from an IPO has
   *  no status of its own. */
  const houseStatus = (o: OrderRow): string | null => (o.parent_order_id ? byId.get(o.parent_order_id)?.status ?? o.status : o.status)

  // Job id and job number both, because each link records a different one.
  const idToNumber = new Map(jobs.map(j => [j.id, j.number]))
  const numberToId = new Map(jobs.filter(j => j.number).map(j => [String(j.number), j.id]))
  const statusForJob = new Map<string, string | null>()

  // 1. A stored link — set when the office linked by hand, or when we created the job.
  for (const o of orders) {
    if (o.sf_job_id && idToNumber.has(o.sf_job_id)) statusForJob.set(o.sf_job_id, houseStatus(o))
    if (o.sf_created_job_number) {
      const id = numberToId.get(o.sf_created_job_number)
      if (id && !statusForJob.has(id)) statusForJob.set(id, houseStatus(o))
    }
  }

  // 2. What the matcher computes, for everything else. Roots only: that is one row per house,
  //    which is exactly what HD Orders lists.
  const unresolved = roots.filter(o => !o.sf_job_id)
  if (unresolved.length) {
    const matches = await resolveSfJobMatches(db, unresolved)
    for (const o of unresolved) {
      const number = matches.get(o.id)?.sfJobNumber
      if (!number) continue
      const id = numberToId.get(String(number))
      if (id && !statusForJob.has(id)) statusForJob.set(id, o.status)
    }
  }

  for (const [jobId, status] of statusForJob) out.set(jobId, portalCompleteFromStatus(status))
  return out
}
