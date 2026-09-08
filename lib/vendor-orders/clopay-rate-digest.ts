import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { enqueueForSubscribers } from '@/lib/notifications/enqueue'
import { clopayPaymentsByPo } from './payments'
import { appUrl } from '@/lib/config/domains'

// Daily digest of Clopay IPO lines paid at something other than the agreed labor rate.
//
// Led BY JOB, with dates. The by-code roll-up alone ("44 codes, $3,086 short") describes the
// shape of the gap but is useless for doing anything about it: a dispute is made job by job,
// and the install date is what decides which schedule version should have applied. So the
// main table is one row per house — POs, customer, install and order dates, what Clopay paid
// and when, the short-paid codes on that job — sorted newest first. The by-code summary is
// kept underneath, because that is the right shape for the rate conversation itself.
//
// Doors are grouped: line items live on individual door orders, and a house is
// (parent_order_id ?? id), so a two-door job is one row carrying both POs.

const NOTIFICATION_KEY = 'clopay_rate_mismatch'
const MAX_JOB_ROWS = 150
const money = (n: number) => `$${Math.abs(n).toFixed(2)}`
const signed = (n: number) => `${n < 0 ? '−' : '+'}${money(n)}`
const signedText = (n: number) => `${n < 0 ? '-' : '+'}${money(n)}`

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

/** 'YYYY-MM-DD' → 'Sep 5'. Formatted from the parts, never through Date, so a plain date
 *  cannot slide a day on a timezone boundary. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function fmtDate(raw: string | null | undefined, withYear = false): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((raw ?? '').trim())
  if (!m) return '—'
  const mon = MONTHS[Number(m[2]) - 1] ?? m[2]
  return withYear ? `${mon} ${Number(m[3])}, ${m[1]}` : `${mon} ${Number(m[3])}`
}

// ── Rows ────────────────────────────────────────────────────────────────────

export interface RateDigestRow {
  code: string
  scheduleRate: number
  paidRate: number
  variance: number      // per unit
  orders: number
  units: number
  dollars: number       // variance × units, the money at stake
}

export interface JobCodeLine { code: string; units: number; scheduleRate: number; paidRate: number; variance: number; dollars: number }

export interface JobVariance {
  rootId: string
  pos: string[]
  customerName: string | null
  address: string | null
  installDate: string | null
  orderDate: string | null
  sfJobNumber: string | null
  paidDate: string | null
  paidAmount: number | null
  codes: JobCodeLine[]
  dollars: number
}

interface VarianceLine { orderId: string; code: string; units: number; scheduleRate: number; paidRate: number; variance: number }

/** Every current IPO line whose paid rate differs from the agreed schedule. */
async function loadVarianceLines(supabase: SupabaseClient): Promise<VarianceLine[]> {
  const { data, error } = await supabase
    .from('vendor_order_line_items')
    .select('order_id, item_number, quantity, unit_fee, schedule_rate, rate_variance')
    .eq('is_current', true)
    .not('rate_variance', 'is', null)
    .neq('rate_variance', 0)
    .limit(5000)
  if (error) { console.error('[clopay-rate-digest] line items:', error.message); return [] }

  const out: VarianceLine[] = []
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const code = String(r.item_number ?? '').trim().toUpperCase()
    const variance = Number(r.rate_variance ?? 0)
    if (!code || Math.abs(variance) < 0.005) continue
    out.push({
      orderId: String(r.order_id),
      code,
      units: Number(r.quantity ?? 0) || 1,
      scheduleRate: Number(r.schedule_rate ?? 0),
      paidRate: Number(r.unit_fee ?? 0),
      variance,
    })
  }
  return out
}

/** Grouped by code and paid rate — the shape of the gap, for the rate conversation.
 *  A code appears twice if Clopay pays it two different ways; that is worth seeing. */
export async function collectRateVariances(supabase: SupabaseClient): Promise<RateDigestRow[]> {
  const groups = new Map<string, RateDigestRow & { orderIds: Set<string> }>()
  for (const l of await loadVarianceLines(supabase)) {
    const key = `${l.code}@${l.paidRate}`
    const g = groups.get(key) ?? { code: l.code, scheduleRate: l.scheduleRate, paidRate: l.paidRate, variance: l.variance, orders: 0, units: 0, dollars: 0, orderIds: new Set<string>() }
    g.units += l.units
    g.dollars = Math.round((g.dollars + l.variance * l.units) * 100) / 100
    g.orderIds.add(l.orderId)
    groups.set(key, g)
  }
  return [...groups.values()]
    .map(({ orderIds, ...g }) => ({ ...g, orders: orderIds.size }))
    .sort((a, b) => Math.abs(b.dollars) - Math.abs(a.dollars))
}

interface OrderRow {
  id: string; parent_order_id: string | null; external_id: string; customer_po: string | null
  customer_name: string | null; street_address: string | null; city: string | null
  order_date: string | null; derived_order_date: string | null; schedule_date: string | null
  sf_created_job_number: string | null; sf_job_id: string | null
}
const ORDER_COLS = 'id, parent_order_id, external_id, customer_po, customer_name, street_address, city, order_date, derived_order_date, schedule_date, sf_created_job_number, sf_job_id'

/** One row per house: every short-paid code on the job, with the dates a dispute needs. */
export async function collectJobVariances(supabase: SupabaseClient): Promise<JobVariance[]> {
  const lines = await loadVarianceLines(supabase)
  if (!lines.length) return []

  // The orders those lines sit on, then their whole group (a house is one row, both doors).
  const orderIds = [...new Set(lines.map(l => l.orderId))]
  const byId = new Map<string, OrderRow>()
  for (let i = 0; i < orderIds.length; i += 200) {
    const { data, error } = await supabase.from('vendor_orders').select(ORDER_COLS).in('id', orderIds.slice(i, i + 200))
    if (error) { console.error('[clopay-rate-digest] orders:', error.message); continue }
    for (const o of (data ?? []) as OrderRow[]) byId.set(o.id, o)
  }
  const rootIds = [...new Set([...byId.values()].map(o => o.parent_order_id ?? o.id))]
  const members = new Map<string, OrderRow[]>()
  for (let i = 0; i < rootIds.length; i += 100) {
    const chunk = rootIds.slice(i, i + 100)
    const { data, error } = await supabase.from('vendor_orders').select(ORDER_COLS)
      .or(`id.in.(${chunk.join(',')}),parent_order_id.in.(${chunk.join(',')})`)
    if (error) { console.error('[clopay-rate-digest] group members:', error.message); continue }
    for (const o of (data ?? []) as OrderRow[]) {
      const root = o.parent_order_id ?? o.id
      const arr = members.get(root) ?? []; arr.push(o); members.set(root, arr)
      if (!byId.has(o.id)) byId.set(o.id, o)
    }
  }

  // Fold the lines into their group.
  const jobs = new Map<string, JobVariance & { codeMap: Map<string, JobCodeLine> }>()
  for (const l of lines) {
    const order = byId.get(l.orderId)
    const root = order?.parent_order_id ?? order?.id ?? l.orderId
    let j = jobs.get(root)
    if (!j) {
      const group = members.get(root) ?? (order ? [order] : [])
      const primary = group.find(o => o.id === root) ?? order ?? null
      const pick = <K extends keyof OrderRow>(k: K): OrderRow[K] | null => {
        for (const o of [primary, ...group]) { const v = o?.[k]; if (v != null && v !== '') return v }
        return null
      }
      j = {
        rootId: root,
        pos: [...new Set(group.flatMap(o => [o.customer_po, o.external_id]).filter((p): p is string => !!p && p.trim() !== ''))],
        customerName: pick('customer_name'),
        address: [pick('street_address'), pick('city')].filter(Boolean).join(', ') || null,
        installDate: pick('schedule_date'),
        orderDate: pick('order_date') ?? pick('derived_order_date'),
        sfJobNumber: pick('sf_created_job_number'),
        paidDate: null, paidAmount: null,
        codes: [], dollars: 0, codeMap: new Map<string, JobCodeLine>(),
      }
      jobs.set(root, j)
    }
    const c = j.codeMap.get(l.code) ?? { code: l.code, units: 0, scheduleRate: l.scheduleRate, paidRate: l.paidRate, variance: l.variance, dollars: 0 }
    c.units += l.units
    c.dollars = Math.round((c.dollars + l.variance * l.units) * 100) / 100
    j.codeMap.set(l.code, c)
    j.dollars = Math.round((j.dollars + l.variance * l.units) * 100) / 100
  }

  // What Clopay actually paid on those POs, and when — the other half of a dispute.
  const out = [...jobs.values()].map(({ codeMap, ...j }) => ({ ...j, codes: [...codeMap.values()].sort((a, b) => a.code.localeCompare(b.code)) }))
  try {
    const { byPo, dateByPo } = await clopayPaymentsByPo(supabase, out.flatMap(j => j.pos))
    for (const j of out) {
      const amounts = j.pos.map(p => byPo.get(p)).filter((n): n is number => n != null)
      const dates = j.pos.map(p => dateByPo.get(p)).filter((d): d is string => !!d).sort()
      if (amounts.length) j.paidAmount = Math.round(amounts.reduce((a, b) => a + b, 0) * 100) / 100
      if (dates.length) j.paidDate = dates[dates.length - 1]
    }
  } catch (e) {
    console.error('[clopay-rate-digest] payments lookup failed (non-critical):', e instanceof Error ? e.message : e)
  }

  // Newest install first: the schedule change has an effective date, so chronology is how
  // you check whether a job should have been paid the old rate or the new one.
  const key = (j: JobVariance) => j.installDate ?? j.orderDate ?? ''
  return out.sort((a, b) => key(b).localeCompare(key(a)) || Math.abs(b.dollars) - Math.abs(a.dollars))
}

// ── Email ───────────────────────────────────────────────────────────────────

const TD = 'padding:6px 10px;border-bottom:1px solid #f3f4f6;vertical-align:top'
const TH = 'padding:6px 10px;text-align:left;font-size:12px;color:#374151'
const SUB = 'color:#6b7280;font-size:12px'

function jobsTable(jobs: JobVariance[]): string {
  const rows = jobs.slice(0, MAX_JOB_ROWS).map(j => {
    const codes = j.codes.map(c => `${c.code}${c.units > 1 ? ` ×${c.units}` : ''} ${signed(c.dollars)}`).join(' · ')
    const rates = j.codes.map(c => `${c.code}: agreed ${money(c.scheduleRate)}, paid ${money(c.paidRate)}`).join(' · ')
    return `
      <tr>
        <td style="${TD}"><strong>${fmtDate(j.installDate)}</strong><div style="${SUB}">ordered ${fmtDate(j.orderDate)}</div></td>
        <td style="${TD}"><span style="font-family:monospace">${j.pos.join(', ') || '—'}</span>
          <div style="${SUB}">${j.sfJobNumber ? `SF job ${j.sfJobNumber}` : 'no SF job'}${j.paidDate ? ` · paid ${fmtDate(j.paidDate)}` : ''}${j.paidAmount != null ? ` (${money(j.paidAmount)})` : ''}</div></td>
        <td style="${TD}">${j.customerName ?? '—'}${j.address ? `<div style="${SUB}">${j.address}</div>` : ''}</td>
        <td style="${TD};font-size:13px">${codes}<div style="${SUB}">${rates}</div></td>
        <td style="${TD};text-align:right;font-weight:600;white-space:nowrap;color:${j.dollars < 0 ? '#b91c1c' : '#1d4ed8'}">${signed(j.dollars)}</td>
      </tr>`
  }).join('')
  const more = jobs.length > MAX_JOB_ROWS
    ? `<p style="${SUB}">Showing the ${MAX_JOB_ROWS} most recent of ${jobs.length} jobs. The rest are on HD Orders → Clopay.</p>` : ''
  return `
    <table style="border-collapse:collapse;font-size:14px;width:100%">
      <thead><tr style="background:#f3f4f6">
        <th style="${TH}">Install</th><th style="${TH}">PO</th><th style="${TH}">Customer</th>
        <th style="${TH}">Short-paid codes</th><th style="${TH};text-align:right">Job total</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>${more}`
}

function codesTable(rows: RateDigestRow[]): string {
  const tr = rows.map(r => `
    <tr>
      <td style="${TD};font-family:monospace">${r.code}</td>
      <td style="${TD};text-align:right">${money(r.scheduleRate)}</td>
      <td style="${TD};text-align:right">${money(r.paidRate)}</td>
      <td style="${TD};text-align:right;color:${r.variance < 0 ? '#b91c1c' : '#1d4ed8'}">${signed(r.variance)}</td>
      <td style="${TD};text-align:right">${r.orders}</td>
      <td style="${TD};text-align:right;font-weight:600;color:${r.dollars < 0 ? '#b91c1c' : '#1d4ed8'}">${signed(r.dollars)}</td>
    </tr>`).join('')
  return `
    <table style="border-collapse:collapse;font-size:14px">
      <thead><tr style="background:#f3f4f6">
        <th style="${TH}">Code</th><th style="${TH};text-align:right">Agreed</th><th style="${TH};text-align:right">Clopay pays</th>
        <th style="${TH};text-align:right">Per unit</th><th style="${TH};text-align:right">Orders</th><th style="${TH};text-align:right">Total</th>
      </tr></thead>
      <tbody>${tr}</tbody>
    </table>`
}

export interface RateDigestResult { ok: boolean; codes: number; jobs: number; dollars: number; sent: number; error?: string }

/** Build and enqueue the digest. No variances ⇒ no email. Never throws. */
export async function sendClopayRateDigest(): Promise<RateDigestResult> {
  try {
    const supabase = db()
    const [codeRows, jobs] = await Promise.all([collectRateVariances(supabase), collectJobVariances(supabase)])
    if (!codeRows.length && !jobs.length) return { ok: true, codes: 0, jobs: 0, dollars: 0, sent: 0 }

    const totalDollars = Math.round(jobs.reduce((a, j) => a + j.dollars, 0) * 100) / 100
    const under = totalDollars < 0
    const headline = `${under ? 'Underpaid' : 'Overpaid'} ${money(totalDollars)} across ${jobs.length} job${jobs.length === 1 ? '' : 's'}`

    const dated = jobs.map(j => j.installDate ?? j.orderDate).filter((d): d is string => !!d).sort()
    const range = dated.length ? `Installs from ${fmtDate(dated[0], true)} to ${fmtDate(dated[dated.length - 1], true)}.` : ''
    const url = `${appUrl()}/admin/vendor-orders`

    const bodyHtml = `
      <p><strong>${headline}</strong> on Clopay IPO line items, against the agreed labor schedule (Exhibit B). ${range}</p>
      ${jobsTable(jobs)}
      <p style="margin-top:22px"><strong>Summary by code</strong> — the same money, grouped for the rate conversation.</p>
      ${codesTable(codeRows)}
      <p style="${SUB}">Each job's variance also shows on <a href="${url}" style="color:#374151">HD Orders → Clopay</a>, with the individual lines in that row's drawer.</p>`

    const bodyText = [
      headline, range, '',
      'BY JOB (newest install first)',
      ...jobs.slice(0, MAX_JOB_ROWS).map(j => [
        `${fmtDate(j.installDate, true)} · PO ${j.pos.join(', ') || '—'} · ${j.customerName ?? '—'}`,
        `  ordered ${fmtDate(j.orderDate, true)}${j.sfJobNumber ? ` · SF job ${j.sfJobNumber}` : ''}${j.paidDate ? ` · paid ${fmtDate(j.paidDate, true)}` : ''}${j.paidAmount != null ? ` (${money(j.paidAmount)})` : ''}`,
        ...j.codes.map(c => `  ${c.code} ×${c.units}: agreed ${money(c.scheduleRate)}, paid ${money(c.paidRate)} → ${signedText(c.dollars)}`),
        `  Job total ${signedText(j.dollars)}`,
      ].join('\n')),
      jobs.length > MAX_JOB_ROWS ? `(showing ${MAX_JOB_ROWS} of ${jobs.length} jobs)` : '',
      '', 'SUMMARY BY CODE',
      ...codeRows.map(r => `${r.code}: agreed ${money(r.scheduleRate)}, paid ${money(r.paidRate)} (${signedText(r.variance)}/unit) — ${r.orders} order(s), ${signedText(r.dollars)}`),
      '', url,
    ].filter(Boolean).join('\n')

    const sent = await enqueueForSubscribers({
      notificationTypeKey: NOTIFICATION_KEY,
      subject: `Clopay rate mismatch — ${headline}`,
      bodyHtml, bodyText,
      relatedEntityType: 'clopay_rates',
      relatedEntityId: new Date().toISOString().slice(0, 10),   // one digest a day
      payload: { codes: codeRows.length, jobs: jobs.length, dollars: totalDollars },
    })
    return { ok: true, codes: codeRows.length, jobs: jobs.length, dollars: totalDollars, sent }
  } catch (e) {
    return { ok: false, codes: 0, jobs: 0, dollars: 0, sent: 0, error: e instanceof Error ? e.message : String(e) }
  }
}
