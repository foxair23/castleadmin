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
}

/** order id → SF job match (number + method + ambiguity). */
export async function resolveSfJobMatches(db: SupabaseClient, orders: OrderLike[]): Promise<Map<string, SfJobMatch>> {
  const out = new Map<string, SfJobMatch>()
  if (orders.length === 0) return out
  const index = await loadSfJobIndex(db, { withContacts: true })
  for (const o of orders) {
    out.set(o.id, matchToSfJob(index, {
      // Genie's PO is customer_po; Clopay has none, and its PO is the external_id
      // (which we also write to the SF job's po_number on create), so fall back.
      po: o.customer_po ?? o.external_id ?? null,
      customerName: o.customer_name,
      email: o.email,
      phone: o.phone,
      linkedJobId: o.sf_job_id,
    }))
  }
  return out
}
