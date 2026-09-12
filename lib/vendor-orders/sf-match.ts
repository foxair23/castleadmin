import type { SupabaseClient } from '@supabase/supabase-js'
import { loadSfJobIndex, matchToSfJob, type SfJobMatch } from '@/lib/matching/sf-job-match'

// Vendor-orders adapter over the shared SF-job matching service. Maps a
// vendor_orders row onto the generic ExternalOrderKey and returns the match.

interface OrderLike {
  id: string
  external_id?: string | null
  customer_po: string | null
  customer_name: string | null
  email: string | null
  phone: string | null
  sf_job_id: string | null
  sf_match_excluded_job_ids?: string[] | null
}

/** order id → SF job match (number + method + ambiguity). */
export async function resolveSfJobMatches(db: SupabaseClient, orders: OrderLike[]): Promise<Map<string, SfJobMatch>> {
  const out = new Map<string, SfJobMatch>()
  if (orders.length === 0) return out
  const index = await loadSfJobIndex(db, { withContacts: true })
  // Jobs the office has unmatched. Looked up here rather than trusting every caller to
  // select the column — a caller that forgot would quietly re-match the rejected job.
  const excluded = new Map<string, string[]>()
  for (const o of orders) if (o.sf_match_excluded_job_ids?.length) excluded.set(o.id, o.sf_match_excluded_job_ids)
  const unknown = orders.filter(o => o.sf_match_excluded_job_ids === undefined).map(o => o.id)
  for (let i = 0; i < unknown.length; i += 150) {
    const { data } = await db.from('vendor_orders').select('id, sf_match_excluded_job_ids').in('id', unknown.slice(i, i + 150)).neq('sf_match_excluded_job_ids', '{}')
    for (const r of (data ?? []) as Array<{ id: string; sf_match_excluded_job_ids: string[] | null }>) if (r.sf_match_excluded_job_ids?.length) excluded.set(r.id, r.sf_match_excluded_job_ids)
  }
  for (const o of orders) {
    out.set(o.id, matchToSfJob(index, {
      // Genie's PO is customer_po; Clopay has none, and its PO is the external_id
      // (which we also write to the SF job's po_number on create), so fall back.
      po: o.customer_po ?? o.external_id ?? null,
      customerName: o.customer_name,
      email: o.email,
      phone: o.phone,
      linkedJobId: o.sf_job_id,
      excludedJobIds: excluded.get(o.id) ?? null,
    }))
  }
  return out
}
