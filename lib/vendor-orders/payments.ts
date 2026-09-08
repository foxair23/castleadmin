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
  /** PO → the latest remittance document date we have for it ('YYYY-MM-DD' when parseable).
   *  Useful when disputing what was paid, and when. Absent for POs with no dated advice. */
  dateByPo: Map<string, string>
}

/** Remittance doc dates arrive as free text ('07/15/2026', '2026-07-15'). Normalise the
 *  shapes we actually see; anything else is left out rather than guessed at. */
function isoDate(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(s)
  if (m) {
    const yr = m[3].length === 2 ? `20${m[3]}` : m[3]
    return `${yr}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  }
  return null
}

export async function clopayPaymentsByPo(db: SupabaseClient, pos: string[]): Promise<PoPayments> {
  const byPo = new Map<string, number>()
  const dateByPo = new Map<string, string>()
  const wanted = [...new Set(pos.map(p => (p ?? '').trim()).filter(Boolean))]
  if (!wanted.length) return { byPo, dateByPo }

  // Scope to Clopay by resolving its email ids first rather than with an embedded filter.
  // remittance_payments is shared with Overhead Door and a PO is only unique within a vendor,
  // but a PostgREST embed is one more thing that can fail quietly — and every failure in this
  // area has been a silent one. Two plain queries, and both report their errors.
  const { data: emails, error: emailErr } = await db
    .from('remittance_emails').select('id').eq('vendor_id', 'clopay')
  if (emailErr) { console.error('[payments] clopay emails:', emailErr.message); return { byPo, dateByPo } }
  const emailIds = new Set(((emails ?? []) as Array<{ id: string }>).map(e => e.id))
  if (!emailIds.size) return { byPo, dateByPo }

  // Chunked: the HD Orders page can carry a thousand POs and `in` travels in the query string.
  const CHUNK = 200
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const { data, error } = await db
      .from('remittance_payments')
      .select('po, amount, apply_status, email_id, doc_date')
      .in('po', wanted.slice(i, i + CHUNK))
    if (error) { console.error('[payments] remittance_payments:', error.message); continue }

    for (const r of (data ?? []) as Array<{ po: string | null; amount: number | string | null; apply_status: string | null; email_id: string; doc_date: string | null }>) {
      const po = (r.po ?? '').trim()
      if (!po || !emailIds.has(r.email_id) || !COUNTED(r.apply_status)) continue
      byPo.set(po, (byPo.get(po) ?? 0) + Number(r.amount ?? 0))
      const d = isoDate(r.doc_date)
      if (d && (!dateByPo.has(po) || d > dateByPo.get(po)!)) dateByPo.set(po, d)
    }
  }
  return { byPo, dateByPo }
}
