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
  parent_order_id?: string | null
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
  // Every PO of the HOUSE, not just this row's. A Clopay house is one job with a PO per
  // door; the office may have put any door's PO on the job, and the main table only shows
  // the root's. Genie's PO is customer_po; Clopay has none, and its PO is the external_id
  // (which we also write to the SF job's po_number on create), so fall back.
  const rowPos = (r: { customer_po: string | null; external_id?: string | null }) => [r.customer_po, r.external_id].filter((v): v is string => !!v)
  const housePos = new Map<string, string[]>()
  {
    const ids = orders.map(o => o.id)
    type Row = { id: string; parent_order_id: string | null; customer_po: string | null; external_id: string | null }
    const rows: Row[] = []
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100).join(',')
      const { data } = await db.from('vendor_orders').select('id, parent_order_id, customer_po, external_id').or(`id.in.(${chunk}),parent_order_id.in.(${chunk})`)
      rows.push(...((data ?? []) as Row[]))
    }
    // A door passed on its own: pull in its root and siblings too.
    const missingRoots = [...new Set(rows.filter(r => r.parent_order_id && !rows.some(x => x.id === r.parent_order_id)).map(r => r.parent_order_id as string))]
    for (let i = 0; i < missingRoots.length; i += 100) {
      const chunk = missingRoots.slice(i, i + 100).join(',')
      const { data } = await db.from('vendor_orders').select('id, parent_order_id, customer_po, external_id').or(`id.in.(${chunk}),parent_order_id.in.(${chunk})`)
      for (const r of (data ?? []) as Row[]) if (!rows.some(x => x.id === r.id)) rows.push(r)
    }
    const byHouse = new Map<string, string[]>()
    for (const r of rows) {
      const h = r.parent_order_id ?? r.id
      byHouse.set(h, [...(byHouse.get(h) ?? []), ...rowPos(r)])
    }
    for (const r of rows) housePos.set(r.id, byHouse.get(r.parent_order_id ?? r.id) ?? [])
  }
  for (const o of orders) {
    const pos = [...rowPos(o), ...(housePos.get(o.id) ?? [])]
    out.set(o.id, matchToSfJob(index, {
      po: [...new Set(pos)].join(';') || null,
      customerName: o.customer_name,
      email: o.email,
      phone: o.phone,
      linkedJobId: o.sf_job_id,
      excludedJobIds: excluded.get(o.id) ?? null,
    }))
  }
  return out
}
