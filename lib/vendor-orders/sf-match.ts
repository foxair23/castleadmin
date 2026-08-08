import type { SupabaseClient } from '@supabase/supabase-js'

// Resolve the SF job number for vendor orders — the same PO-based approach
// Remittances uses (match the order's PO against sf_jobs.po_number, which may
// carry several POs separated by ; / , — so we check membership, not equality).
// A directly-linked job (sf_job_id, set in Phase 2 when we create the job) wins
// over a PO match.

const splitPos = (raw: string | null): string[] =>
  (raw ?? '').split(/[;/,]/).map(s => s.trim()).filter(Boolean)

interface OrderLike { id: string; customer_po: string | null; sf_job_id: string | null }

/** order id → SF job number (or null if no linked/PO-matched job). */
export async function resolveSfJobNumbers(db: SupabaseClient, orders: OrderLike[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  const pos = [...new Set(orders.map(o => o.customer_po).filter((p): p is string => !!p))]
  const linkedIds = [...new Set(orders.map(o => o.sf_job_id).filter((i): i is string => !!i))]

  // PO → job. Exact-match the indexed po_number (the common case: one PO/job);
  // split covers a job that lists several.
  const byPo = new Map<string, string | null>()
  if (pos.length) {
    const { data } = await db.from('sf_jobs').select('id, number, po_number').eq('is_deleted', false).in('po_number', pos)
    for (const j of (data ?? []) as Array<{ number: string | null; po_number: string | null }>) {
      for (const p of splitPos(j.po_number)) if (!byPo.has(p)) byPo.set(p, j.number)
    }
  }

  // Directly-linked job (Phase 2).
  const byId = new Map<string, string | null>()
  if (linkedIds.length) {
    const { data } = await db.from('sf_jobs').select('id, number').in('id', linkedIds)
    for (const j of (data ?? []) as Array<{ id: string; number: string | null }>) byId.set(j.id, j.number)
  }

  for (const o of orders) {
    if (o.sf_job_id && byId.has(o.sf_job_id)) out.set(o.id, byId.get(o.sf_job_id) ?? null)
    else if (o.customer_po && byPo.has(o.customer_po)) out.set(o.id, byPo.get(o.customer_po) ?? null)
    else out.set(o.id, null)
  }
  return out
}
