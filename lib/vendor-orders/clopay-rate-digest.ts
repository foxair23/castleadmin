import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { enqueueForSubscribers } from '@/lib/notifications/enqueue'

// Daily digest of Clopay IPO lines paid at something other than the agreed rate.
//
// Grouped BY CODE, not by order, and that is the whole design. The gap here is systematic —
// every labor line in the captured IPOs is exactly one $4 adjustment short of the schedule
// effective 2026-06-29 — so a per-order alert would be an email per door and nobody would
// read the tenth one. One row per code, with the order count and the money behind it, is
// what a rate conversation with Clopay actually needs.

const NOTIFICATION_KEY = 'clopay_rate_mismatch'
const money = (n: number) => `$${Math.abs(n).toFixed(2)}`

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export interface RateDigestRow {
  code: string
  scheduleRate: number
  paidRate: number
  variance: number      // per unit
  orders: number
  units: number
  dollars: number       // variance × units, the money at stake
}
export interface RateDigestResult { ok: boolean; codes: number; dollars: number; sent: number; error?: string }

/** Every current IPO line whose rate differs from the schedule, grouped by code and paid rate.
 *  A code can appear twice if Clopay pays it two different ways — worth seeing separately. */
export async function collectRateVariances(supabase: SupabaseClient): Promise<RateDigestRow[]> {
  const { data, error } = await supabase
    .from('vendor_order_line_items')
    .select('order_id, item_number, quantity, unit_fee, schedule_rate, rate_variance')
    .eq('is_current', true)
    .not('rate_variance', 'is', null)
    .neq('rate_variance', 0)
    .limit(5000)
  if (error) { console.error('[clopay-rate-digest]', error.message); return [] }

  const groups = new Map<string, RateDigestRow & { orderIds: Set<string> }>()
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const code = String(r.item_number ?? '').trim().toUpperCase()
    const paid = Number(r.unit_fee ?? 0)
    const sched = Number(r.schedule_rate ?? 0)
    const variance = Number(r.rate_variance ?? 0)
    if (!code || Math.abs(variance) < 0.005) continue
    const key = `${code}@${paid}`
    const g = groups.get(key) ?? { code, scheduleRate: sched, paidRate: paid, variance, orders: 0, units: 0, dollars: 0, orderIds: new Set<string>() }
    const qty = Number(r.quantity ?? 0) || 1
    g.units += qty
    g.dollars = Math.round((g.dollars + variance * qty) * 100) / 100
    g.orderIds.add(String(r.order_id))
    groups.set(key, g)
  }
  return [...groups.values()]
    .map(({ orderIds, ...g }) => ({ ...g, orders: orderIds.size }))
    // Biggest exposure first — that is the order someone would work them in.
    .sort((a, b) => Math.abs(b.dollars) - Math.abs(a.dollars))
}

/** Build and enqueue the digest. No variances ⇒ no email. Never throws. */
export async function sendClopayRateDigest(): Promise<RateDigestResult> {
  try {
    const supabase = db()
    const rows = await collectRateVariances(supabase)
    if (!rows.length) return { ok: true, codes: 0, dollars: 0, sent: 0 }

    const totalDollars = Math.round(rows.reduce((a, r) => a + r.dollars, 0) * 100) / 100
    const under = totalDollars < 0
    const headline = `${under ? 'Underpaid' : 'Overpaid'} ${money(totalDollars)} across ${rows.length} code${rows.length === 1 ? '' : 's'}`

    const tr = rows.map(r => `
      <tr>
        <td style="padding:6px 10px;font-family:monospace">${r.code}</td>
        <td style="padding:6px 10px;text-align:right">${money(r.scheduleRate)}</td>
        <td style="padding:6px 10px;text-align:right">${money(r.paidRate)}</td>
        <td style="padding:6px 10px;text-align:right;color:${r.variance < 0 ? '#b91c1c' : '#1d4ed8'}">${r.variance < 0 ? '−' : '+'}${money(r.variance)}</td>
        <td style="padding:6px 10px;text-align:right">${r.orders}</td>
        <td style="padding:6px 10px;text-align:right;font-weight:600;color:${r.dollars < 0 ? '#b91c1c' : '#1d4ed8'}">${r.dollars < 0 ? '−' : '+'}${money(r.dollars)}</td>
      </tr>`).join('')

    const bodyHtml = `
      <p><strong>${headline}</strong> on Clopay IPO line items, against the agreed labor schedule.</p>
      <table style="border-collapse:collapse;font-size:14px">
        <thead><tr style="background:#f3f4f6">
          <th style="padding:6px 10px;text-align:left">Code</th>
          <th style="padding:6px 10px;text-align:right">Agreed</th>
          <th style="padding:6px 10px;text-align:right">Clopay pays</th>
          <th style="padding:6px 10px;text-align:right">Per unit</th>
          <th style="padding:6px 10px;text-align:right">Orders</th>
          <th style="padding:6px 10px;text-align:right">Total</th>
        </tr></thead>
        <tbody>${tr}</tbody>
      </table>
      <p style="color:#6b7280;font-size:12px">Rates come from Clopay's agreed labor schedule (Exhibit B). Each job's variance is also shown on HD Orders → Clopay, and the individual lines in that row's drawer.</p>`

    const bodyText = [headline, '', ...rows.map(r =>
      `${r.code}: agreed ${money(r.scheduleRate)}, paid ${money(r.paidRate)} (${r.variance < 0 ? '-' : '+'}${money(r.variance)}/unit) — ${r.orders} order(s), ${r.dollars < 0 ? '-' : '+'}${money(r.dollars)}`)].join('\n')

    const sent = await enqueueForSubscribers({
      notificationTypeKey: NOTIFICATION_KEY,
      subject: `Clopay rate mismatch — ${headline}`,
      bodyHtml, bodyText,
      relatedEntityType: 'clopay_rates',
      relatedEntityId: new Date().toISOString().slice(0, 10),   // one digest a day
      payload: { codes: rows.length, dollars: totalDollars },
    })
    return { ok: true, codes: rows.length, dollars: totalDollars, sent }
  } catch (e) {
    return { ok: false, codes: 0, dollars: 0, sent: 0, error: e instanceof Error ? e.message : String(e) }
  }
}
