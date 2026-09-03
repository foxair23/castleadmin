import type { SupabaseClient } from '@supabase/supabase-js'

// What Clopay has actually PAID us, keyed by PO.
//
// Forwarded remittance advices are already parsed into remittance_payments, one row per line
// with a `po` and an `amount` (migration 078). The Clopay parser reads the PO as plain digits
// (lib/remittance/parse.ts), which is the same shape the portal gives vendor_orders.customer_po
// — so this is a direct string match, no fuzzy logic and no new identifier.

/** Payment lines are Clopay's own advice that the money has been sent, so they count whether
 *  or not we have applied them in Service Fusion — apply_status and match_status describe our
 *  bookkeeping, not the payment. 'excluded' is the exception: a person has explicitly said
 *  that line does not belong. */
const COUNTED = (applyStatus: string | null) => applyStatus !== 'excluded'

export interface PoPayments {
  /** PO → dollars received. POs with nothing received are absent, not zero. */
  byPo: Map<string, number>
}

export async function clopayPaymentsByPo(db: SupabaseClient, pos: string[]): Promise<PoPayments> {
  const byPo = new Map<string, number>()
  const wanted = [...new Set(pos.map(p => (p ?? '').trim()).filter(Boolean))]
  if (!wanted.length) return { byPo }

  // Scope to Clopay by resolving its email ids first rather than with an embedded filter.
  // remittance_payments is shared with Overhead Door and a PO is only unique within a vendor,
  // but a PostgREST embed is one more thing that can fail quietly — and every failure in this
  // area has been a silent one. Two plain queries, and both report their errors.
  const { data: emails, error: emailErr } = await db
    .from('remittance_emails').select('id').eq('vendor_id', 'clopay')
  if (emailErr) { console.error('[payments] clopay emails:', emailErr.message); return { byPo } }
  const emailIds = new Set(((emails ?? []) as Array<{ id: string }>).map(e => e.id))
  if (!emailIds.size) return { byPo }

  // Chunked: the HD Orders page can carry a thousand POs and `in` travels in the query string.
  const CHUNK = 200
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const { data, error } = await db
      .from('remittance_payments')
      .select('po, amount, apply_status, email_id')
      .in('po', wanted.slice(i, i + CHUNK))
    if (error) { console.error('[payments] remittance_payments:', error.message); continue }

    for (const r of (data ?? []) as Array<{ po: string | null; amount: number | string | null; apply_status: string | null; email_id: string }>) {
      const po = (r.po ?? '').trim()
      if (!po || !emailIds.has(r.email_id) || !COUNTED(r.apply_status)) continue
      byPo.set(po, (byPo.get(po) ?? 0) + Number(r.amount ?? 0))
    }
  }
  return { byPo }
}
