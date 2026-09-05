import type { SupabaseClient } from '@supabase/supabase-js'

// Turn parsed IPO line items into Service Fusion job services.
//
// Shape comes from the RAML spec in the repo (typ.JobServiceBody): `service` is the only
// required field (a catalog id or name), `multiplier` is the quantity, `rate` the unit price.
// Omitting `rate` makes SF fall back to its catalog default — which is currently $4 per door
// out of date, so we always send the IPO's rate and the job reflects what Clopay actually pays.

export interface SfServiceLine {
  service: string
  name: string
  description?: string
  multiplier: number
  rate: number
}

export interface IpoLineRow {
  order_id: string
  item_number: string | null
  description: string | null
  quantity: number | null
  line_fee: number | null
  unit_fee: number | null
}

/** SF documents `multiplier` as an integer. A line always covers at least one unit. */
const toMultiplier = (q: number | null | undefined) => Math.max(1, Math.round(Number(q ?? 1)))

/** Every current IPO line for a set of orders (a whole door group), in reading order. */
export async function loadIpoLines(db: SupabaseClient, orderIds: string[]): Promise<IpoLineRow[]> {
  const ids = [...new Set(orderIds.filter(Boolean))]
  if (!ids.length) return []
  const { data, error } = await db
    .from('vendor_order_line_items')
    .select('order_id, item_number, description, quantity, line_fee, unit_fee')
    .in('order_id', ids)
    .eq('is_current', true)
    .order('sort_order', { ascending: true })
  if (error) { console.error('[ipo-services] load lines:', error.message); return [] }
  return (data ?? []) as IpoLineRow[]
}

/** Map IPO lines onto SF service lines.
 *
 *  Only lines that CARRY REVENUE are sent. Those are the ones in Castle's SF services
 *  catalog; the $0.00 rows are Clopay product codes (DC13, 3553061, 0650792 …) that may not
 *  exist as SF services, and sending an unknown `service` is a 422 that costs the whole
 *  array. They also add nothing to what the job is worth.
 *
 *  Note this is a DIFFERENT filter from the rate schedule: FIR1010 carries revenue but has no
 *  agreed rate, so it is sent to SF while never being flagged as a variance.
 *
 *  `poByOrder` labels each line with the door it came from — on a multi-door job the same
 *  code can appear per door, and without the PO the office cannot tell them apart. */
export function toSfServices(lines: IpoLineRow[], poByOrder?: Map<string, string | null>): SfServiceLine[] {
  const multiDoor = poByOrder != null && new Set([...poByOrder.values()].filter(Boolean)).size > 1
  const out: SfServiceLine[] = []
  for (const l of lines) {
    const code = (l.item_number ?? '').trim()
    const fee = Number(l.line_fee ?? 0)
    if (!code || fee <= 0) continue
    const po = poByOrder?.get(l.order_id) ?? null
    const desc = (l.description ?? '').trim()
    out.push({
      service: code,
      name: code,
      description: multiDoor && po ? `PO ${po}${desc ? ` — ${desc}` : ''}` : (desc || undefined),
      multiplier: toMultiplier(l.quantity),
      // The IPO's UNIT rate. line_fee is the line total, so sending it as `rate` would
      // multiply the money by the quantity.
      rate: Number(l.unit_fee ?? (fee / toMultiplier(l.quantity))),
    } as SfServiceLine)
  }
  return out
}
