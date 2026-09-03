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

  // remittance_payments is shared with Overhead Door, so scope to the Clopay emails — a PO
  // number is only unique within a vendor. Chunked because the HD Orders page can carry a
  // thousand POs and `in` travels in the query string.
  const CHUNK = 200
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const { data } = await db
      .from('remittance_payments')
      .select('po, amount, apply_status, remittance_emails!inner(vendor_id)')
      .eq('remittance_emails.vendor_id', 'clopay')
      .in('po', wanted.slice(i, i + CHUNK))

    for (const r of (data ?? []) as Array<{ po: string | null; amount: number | string | null; apply_status: string | null }>) {
      const po = (r.po ?? '').trim()
      if (!po || !COUNTED(r.apply_status)) continue
      byPo.set(po, (byPo.get(po) ?? 0) + Number(r.amount ?? 0))
    }
  }
  return { byPo }
}
