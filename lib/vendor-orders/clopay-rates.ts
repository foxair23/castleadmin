import type { SupabaseClient } from '@supabase/supabase-js'

// Clopay's agreed labor rates (Exhibit B) vs what an IPO actually pays.
//
// Two rules make this comparison correct, and both are easy to get wrong:
//
//   1. The IPO prints a LINE TOTAL; the schedule is a UNIT rate. Compare line_fee / quantity.
//      Comparing raw totals made FIR930 (quantity 4, $600) look like a $446 discrepancy when
//      the real gap was $4 a unit.
//   2. Only labor codes are in the schedule. An IPO also lists doors, openers and parts
//      (DC13, 3553061, 0650792 …) at $0.00 — those have no agreed rate and are not variances.

/** Cents-level tolerance. Rates are whole dollars, so anything at or above this is real. */
const EPSILON = 0.005

export interface RateComparison {
  unitFee: number
  scheduleRate: number | null
  /** unitFee − scheduleRate. Negative = Clopay paid less than agreed. Null when unrated. */
  variance: number | null
}

/** The unit fee an IPO line implies. Quantity 0/null is treated as 1 — a line always
 *  represents at least one unit, and dividing by zero would poison every downstream number. */
export function unitFee(lineFee: number | null | undefined, quantity: number | null | undefined): number {
  const qty = Number(quantity ?? 0)
  return Math.round((Number(lineFee ?? 0) / (qty > 0 ? qty : 1)) * 100) / 100
}

export function compareToSchedule(
  lineFee: number | null | undefined,
  quantity: number | null | undefined,
  scheduleRate: number | null | undefined,
): RateComparison {
  const fee = unitFee(lineFee, quantity)
  if (scheduleRate == null) return { unitFee: fee, scheduleRate: null, variance: null }
  const rate = Number(scheduleRate)
  const diff = Math.round((fee - rate) * 100) / 100
  return { unitFee: fee, scheduleRate: rate, variance: Math.abs(diff) < EPSILON ? 0 : diff }
}

/** The agreed rate for each code, keyed UPPERCASE to match however the IPO prints it. */
export async function loadRateSchedule(db: SupabaseClient): Promise<Map<string, number>> {
  const { data, error } = await db.from('clopay_rate_schedule').select('code, rate')
  if (error) { console.error('[clopay-rates] schedule load:', error.message); return new Map() }
  return new Map(((data ?? []) as Array<{ code: string; rate: number | string }>)
    .map(r => [r.code.trim().toUpperCase(), Number(r.rate)]))
}

/** The variance columns for one parsed IPO line, ready to store alongside it. */
export function variancePatch(
  schedule: Map<string, number>,
  itemNumber: string | null | undefined,
  lineFee: number | null | undefined,
  quantity: number | null | undefined,
): { unit_fee: number; schedule_rate: number | null; rate_variance: number | null } {
  const code = (itemNumber ?? '').trim().toUpperCase()
  const c = compareToSchedule(lineFee, quantity, code ? schedule.get(code) ?? null : null)
  return { unit_fee: c.unitFee, schedule_rate: c.scheduleRate, rate_variance: c.variance }
}

/** Total rate variance per order, in dollars, from its CURRENT IPO lines.
 *  Multiplied by quantity, because a $4 unit shortfall on a quantity-4 line is $16 of real
 *  money — the per-unit figure is for reading a line, this is for reading a job. */
export async function varianceByOrder(db: SupabaseClient, orderIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const ids = [...new Set(orderIds.filter(Boolean))]
  if (!ids.length) return out

  const CHUNK = 300
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await db
      .from('vendor_order_line_items')
      .select('order_id, quantity, rate_variance')
      .in('order_id', ids.slice(i, i + CHUNK))
      .eq('is_current', true)
      .not('rate_variance', 'is', null)
    if (error) { console.error('[clopay-rates] variance by order:', error.message); continue }
    for (const r of (data ?? []) as Array<{ order_id: string; quantity: number | null; rate_variance: number | string | null }>) {
      const v = Number(r.rate_variance ?? 0)
      if (Math.abs(v) < EPSILON) continue
      const qty = Number(r.quantity ?? 0) || 1
      out.set(r.order_id, Math.round(((out.get(r.order_id) ?? 0) + v * qty) * 100) / 100)
    }
  }
  return out
}
