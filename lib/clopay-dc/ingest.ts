import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { parseDcReport, type DcReportRow } from './report-parse'

// Ingest one weekly Clopay DC report.
//
// The central property: a PO appears on EVERY Monday report for as long as its product sits
// at the DC — sometimes for months, sometimes because the customer asked us to wait. So
// ingesting the same PO again must never resurrect a worklist item someone already handled.
// clopay_dc_po_state.scheduled_at is therefore written once and never cleared here.

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

/** The worklist unit is the PO — a customer can have one PO arrive while another has not.
 *  Castle-direct rows have no PO, so they key on their order number instead. */
export const poKeyFor = (r: { po: string | null; orderNo: string }) => r.po ? `PO:${r.po}` : `ORDER:${r.orderNo}`

export interface DcIngestResult {
  ok: boolean
  status: 'ingested' | 'duplicate' | 'parse_failed'
  reportDate?: string
  rows?: number
  linked?: number
  newPos?: number
  error?: string
}

export async function ingestDcReport(opts: {
  text: string
  reportDate?: string | null
  storagePath?: string | null
  resendEmailId?: string | null
  source?: 'email' | 'manual'
}): Promise<DcIngestResult> {
  const supabase = db()

  // Same forwarded email twice (a Resend retry, or a second forward) ingests once.
  if (opts.resendEmailId) {
    const { data: dupe } = await supabase.from('clopay_dc_reports')
      .select('id, report_date').eq('resend_email_id', opts.resendEmailId).maybeSingle()
    if (dupe) return { ok: true, status: 'duplicate', reportDate: dupe.report_date as string }
  }

  const parsed = parseDcReport(opts.text)
  const reportDate = opts.reportDate ?? parsed.reportDate ?? new Date().toISOString().slice(0, 10)

  // Store the report even when the parse is poor: raw_text means a parser fix can be re-run
  // later without asking for the email again.
  const { data: report, error: repErr } = await supabase.from('clopay_dc_reports').upsert({
    report_date: reportDate,
    source: opts.source ?? 'email',
    resend_email_id: opts.resendEmailId ?? null,
    storage_path: opts.storagePath ?? null,
    raw_text: opts.text,
    row_count: parsed.rows.length,
    parse_ok: parsed.ok,
  }, { onConflict: 'report_date' }).select('id').maybeSingle()
  if (repErr || !report) return { ok: false, status: 'parse_failed', error: repErr?.message ?? 'report insert failed' }

  if (parsed.rows.length === 0) {
    return { ok: false, status: 'parse_failed', reportDate, rows: 0, error: 'no rows recognised' }
  }

  const reportId = report.id as string
  // Re-ingesting the same report_date replaces its rows rather than doubling them.
  await supabase.from('clopay_dc_report_rows').delete().eq('report_id', reportId)

  const linkedIds = await resolveOrders(supabase, parsed.rows)
  await supabase.from('clopay_dc_report_rows').insert(parsed.rows.map(r => ({
    report_id: reportId,
    order_no: r.orderNo,
    po: r.po,
    kind: r.kind,
    entered_date: r.enteredDate,
    reserved_date: r.reservedDate,
    order_id: linkedIds.get(r.orderNo) ?? null,
  })))

  const newPos = await upsertPoState(supabase, parsed.rows, linkedIds, reportDate)
  await refreshOrderDcFields(supabase, parsed.rows, linkedIds, reportDate)

  return {
    ok: true, status: 'ingested', reportDate,
    rows: parsed.rows.length, linked: linkedIds.size, newPos,
  }
}

/** Link report rows to vendor_orders. The Clopay ORDER NUMBER is the reliable key — it is the
 *  same identifier the portal lists, the IPO prints as "Order Number", and this report puts in
 *  its first column. PO is only a fallback: the POs genuinely disagree across systems (COOREY
 *  PETE is 68443705 in the portal but 68443644/68443645 here), so matching on PO alone would
 *  miss real orders. */
async function resolveOrders(
  supabase: SupabaseClient, rows: DcReportRow[],
): Promise<Map<string, string>> {
  const byOrderNo = new Map<string, string>()
  const orderNos = [...new Set(rows.map(r => r.orderNo))]
  const pos = [...new Set(rows.map(r => r.po).filter((p): p is string => !!p))]

  const [{ data: byId }, { data: byPo }] = await Promise.all([
    supabase.from('vendor_orders').select('id, external_id').eq('vendor', 'clopay_hd').in('external_id', orderNos.length ? orderNos : ['__none__']),
    pos.length
      ? supabase.from('vendor_orders').select('id, customer_po').eq('vendor', 'clopay_hd').in('customer_po', pos)
      : Promise.resolve({ data: [] as Array<{ id: string; customer_po: string | null }> }),
  ])

  const idByExternal = new Map(((byId ?? []) as Array<{ id: string; external_id: string }>).map(o => [o.external_id, o.id]))
  const idByPo = new Map(((byPo ?? []) as Array<{ id: string; customer_po: string | null }>)
    .filter(o => o.customer_po).map(o => [o.customer_po as string, o.id]))

  for (const r of rows) {
    const hit = idByExternal.get(r.orderNo) ?? (r.po ? idByPo.get(r.po) : undefined)
    if (hit) byOrderNo.set(r.orderNo, hit)
  }
  return byOrderNo
}

/** New POs get a state row; POs already known only have last_seen_report bumped. scheduled_at
 *  is never touched — that is what makes "Scheduled" stick across the weeks a PO keeps
 *  appearing. Returns how many POs were seen for the first time. */
async function upsertPoState(
  supabase: SupabaseClient, rows: DcReportRow[], linked: Map<string, string>, reportDate: string,
): Promise<number> {
  const keys = rows.map(poKeyFor)
  const { data: existing } = await supabase.from('clopay_dc_po_state')
    .select('po_key').in('po_key', keys.length ? keys : ['__none__'])
  const known = new Set(((existing ?? []) as Array<{ po_key: string }>).map(r => r.po_key))

  const fresh = rows.filter(r => !known.has(poKeyFor(r)))
  if (fresh.length) {
    await supabase.from('clopay_dc_po_state').insert(fresh.map(r => ({
      po_key: poKeyFor(r),
      order_no: r.orderNo,
      po: r.po,
      kind: r.kind,
      first_seen_report: reportDate,
      last_seen_report: reportDate,
      entered_date: r.enteredDate,
      reserved_date: r.reservedDate,
      order_id: linked.get(r.orderNo) ?? null,
    })))
  }

  // Refresh what the newest report says about POs we already track, but never the dismissal.
  for (const r of rows.filter(x => known.has(poKeyFor(x)))) {
    await supabase.from('clopay_dc_po_state').update({
      last_seen_report: reportDate,
      reserved_date: r.reservedDate,
      entered_date: r.enteredDate,
      order_id: linked.get(r.orderNo) ?? null,
    }).eq('po_key', poKeyFor(r))
  }
  return fresh.length
}

/** Denormalize the aging onto the order so HD Orders can show it without a join. */
async function refreshOrderDcFields(
  supabase: SupabaseClient, rows: DcReportRow[], linked: Map<string, string>, reportDate: string,
): Promise<void> {
  for (const r of rows) {
    const id = linked.get(r.orderNo)
    if (!id) continue
    await supabase.from('vendor_orders')
      .update({ dc_reserved_at: r.reservedDate, dc_last_seen_at: reportDate })
      .eq('id', id)
  }
}
