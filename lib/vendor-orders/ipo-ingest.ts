import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { downloadVendorDoc } from './attachments'
import { isIpoDoc, parseIpoDocument, type IpoParseResult } from './clopay-ipo'

// Turn a stored Clopay IPO PDF into structured line items.
//
// Runs off the stored document (the crawler already captured the bytes), so parsing is
// decoupled from the fragile capture path: a parse failure can never break a doc sync, and
// re-parsing is always possible if the parser improves.
//
// A document may bundle SEVERAL IPOs — one per page, one per order in a multi-door job —
// and Clopay attaches the same bundle to every order in the group. So a section is ALWAYS
// attributed by its own `Order Number`, never by position. Sections for orders that don't
// exist in vendor_orders are recovered as `record_source='ipo_document'` rows: those orders
// are real (real PO, real money, physically at the DC) but never appear in the HD Program
// portal, so the crawler cannot see them.

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

/** Clopay's Oracle generator pads PDFs out to a fixed size (many are exactly 1,280,000
 *  bytes). Trimming past the last %%EOF keeps the PDF reader from chewing through filler. */
function trimPdfPadding(bytes: Uint8Array): Uint8Array {
  const idx = Buffer.from(bytes).lastIndexOf(Buffer.from('%%EOF'))
  return idx > 0 ? bytes.slice(0, idx + 5) : bytes
}

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(trimPdfPadding(bytes))
  const { text } = await extractText(pdf, { mergePages: true })
  return typeof text === 'string' ? text : String(text ?? '')
}

export interface IpoIngestResult {
  ok: boolean
  status: 'ok' | 'mismatch' | 'error' | 'not_ipo'
  sections?: number
  lines?: number
  totalFee?: number | null
  /** Orders in the document that we had no record of, now recovered. */
  recovered?: string[]
  error?: string
}

/** Parse one stored attachment and persist every IPO it contains. Never throws — the
 *  outcome is recorded on the attachment so a backfill moves on and problems stay visible. */
export async function parseAndStoreIpoAttachment(attachmentId: string): Promise<IpoIngestResult> {
  const supabase = db()
  const { data: att } = await supabase
    .from('vendor_order_attachments')
    .select('id, order_id, filename, storage_path, external_ref')
    .eq('id', attachmentId)
    .maybeSingle()
  if (!att) return { ok: false, status: 'error', error: 'attachment not found' }

  const stamp = async (status: IpoIngestResult['status'], totalFee: number | null) => {
    await supabase.from('vendor_order_attachments')
      .update({ parsed_at: new Date().toISOString(), parse_status: status, parsed_total_fee: totalFee })
      .eq('id', att.id)
  }

  if (!isIpoDoc(att.filename as string | null)) { await stamp('not_ipo', null); return { ok: true, status: 'not_ipo' } }

  // Which order does this document hang off? Its own section is the authoritative one.
  const { data: owner } = await supabase
    .from('vendor_orders').select('id, external_id, vendor').eq('id', att.order_id).maybeSingle()

  let sections: IpoParseResult[]
  try {
    const bytes = await downloadVendorDoc(att.storage_path as string)
    if (!bytes) { await stamp('error', null); return { ok: false, status: 'error', error: 'download failed' } }
    sections = parseIpoDocument(await extractPdfText(bytes))
  } catch (e) {
    await stamp('error', null)
    return { ok: false, status: 'error', error: e instanceof Error ? e.message : String(e) }
  }
  if (!sections.length) { await stamp('error', null); return { ok: false, status: 'error', error: 'no IPO sections found' } }

  // Replace everything this document previously produced (re-parsing must not duplicate).
  await supabase.from('vendor_order_line_items').delete().eq('attachment_id', att.id)

  const recovered: string[] = []
  let storedLines = 0
  let ownerSectionOk: boolean | null = null
  let ownerTotal: number | null = null
  const touchedOrders = new Set<string>()
  // Every order in this bundle, for the multi-door grouping below.
  const groupMembers: Array<{ id: string; externalId: string; isPortal: boolean }> = []

  for (const sec of sections) {
    if (!sec.orderNumber || sec.items.length === 0) continue
    // Resolve the section to ITS OWN order — never the document's owner by position.
    let orderId: string | null = null
    const { data: match } = await supabase
      .from('vendor_orders').select('id').eq('vendor', 'clopay_hd').eq('external_id', sec.orderNumber).maybeSingle()
    if (match) orderId = match.id as string
    else if (owner?.vendor === 'clopay_hd') {
      // An order Clopay bills us for that the portal never shows — recover it so the work
      // (and the money) is visible instead of invisible.
      const { data: created } = await supabase.from('vendor_orders').insert({
        vendor: 'clopay_hd',
        external_id: sec.orderNumber,
        customer_po: sec.poNumber,
        order_date: sec.orderDate,
        derived_order_date: sec.orderDate,
        derived_total_fee: sec.totalFee,
        record_source: 'ipo_document',
        has_detail: false,
        // The IPO's SHIP TO block is the only contact detail these orders will ever have
        // (the portal never lists them), so without it they'd be blank rows.
        customer_name: sec.customer.customerName,
        street_address: sec.customer.streetAddress,
        city: sec.customer.city,
        state_prov: sec.customer.stateProv,
        postal_code: sec.customer.postalCode,
        phone: sec.customer.phone,
      }).select('id').maybeSingle()
      if (created) { orderId = created.id as string; recovered.push(sec.orderNumber) }
    }
    if (!orderId) continue
    groupMembers.push({ id: orderId, externalId: sec.orderNumber, isPortal: !!match })

    const rows = sec.items.map((i, n) => ({
      order_id: orderId,
      attachment_id: att.id,
      source_document_ref: att.external_ref ?? null,
      source_order_number: sec.orderNumber,
      line_no: i.line_no,
      quantity: i.quantity,
      item_number: i.item_number,
      description: i.description,
      line_fee: i.line_fee,
      sort_order: n,
    }))
    const { error: insErr } = await supabase.from('vendor_order_line_items').insert(rows)
    if (!insErr) { storedLines += rows.length; touchedOrders.add(orderId) }

    if (owner && sec.orderNumber === owner.external_id) { ownerSectionOk = sec.ok; ownerTotal = sec.totalFee }
  }

  // A bundle IS the job: link its doors under one primary so the list shows one row per
  // house and autopilot creates one SF job (migration 106).
  const parentId = await linkOrderGroup(supabase, groupMembers)
  for (const oid of touchedOrders) await refreshOrderIpoTotals(supabase, oid)
  if (parentId) await rollUpGroupTotal(supabase, parentId)

  // 'mismatch' means a section's fees didn't sum to its stated total, OR this document
  // contains no section for the order it is attached to (an attribution problem, which is
  // exactly the bug that made a sibling's total show on the wrong order).
  const status: IpoIngestResult['status'] =
    ownerSectionOk === null ? 'mismatch' : (ownerSectionOk ? 'ok' : 'mismatch')
  await stamp(status, ownerTotal)
  return { ok: true, status, sections: sections.length, lines: storedLines, totalFee: ownerTotal, recovered }
}

/** Link the doors of one bundled IPO into a single group. The primary is a portal-sourced
 *  order when there is one (only those carry status/notes/documents/schedule), else the
 *  lowest order number — a stable choice, so re-parsing never reshuffles the group. If a
 *  later crawl turns a recovered door into a portal order, the portal row takes over. */
async function linkOrderGroup(
  supabase: SupabaseClient,
  members: Array<{ id: string; externalId: string; isPortal: boolean }>,
): Promise<string | null> {
  if (members.length === 0) return null
  const unique = [...new Map(members.map(m => [m.id, m])).values()]
  if (unique.length === 1) return unique[0].id // single-door job — nothing to group

  const sorted = [...unique].sort((a, b) =>
    (b.isPortal ? 1 : 0) - (a.isPortal ? 1 : 0) || a.externalId.localeCompare(b.externalId))
  const parent = sorted[0]
  const children = sorted.slice(1).map(m => m.id)

  await supabase.from('vendor_orders').update({ parent_order_id: null }).eq('id', parent.id)
  if (children.length) {
    await supabase.from('vendor_orders').update({ parent_order_id: parent.id }).in('id', children)
  }
  return parent.id
}

/** The primary carries the WHOLE job's money — that's what the single SF job is worth —
 *  while each door keeps its own total for the per-door breakdown. */
async function rollUpGroupTotal(supabase: SupabaseClient, parentId: string): Promise<void> {
  const { data: kids } = await supabase
    .from('vendor_orders').select('derived_total_fee').eq('parent_order_id', parentId)
  const { data: self } = await supabase
    .from('vendor_orders').select('derived_total_fee').eq('id', parentId).maybeSingle()
  const rows = (kids ?? []) as Array<{ derived_total_fee: number | null }>
  if (!rows.length) return // not a group
  const total = Number(self?.derived_total_fee ?? 0)
    + rows.reduce((a, r) => a + Number(r.derived_total_fee ?? 0), 0)
  await supabase.from('vendor_orders')
    .update({ derived_total_fee: total, updated_at: new Date().toISOString() })
    .eq('id', parentId)
}

/** Point an order at its CURRENT IPO: a change order produces a revised IPO that restates
 *  the whole order, so the newest successfully parsed document wins. Older documents keep
 *  their line items (history) but are flagged is_current=false. */
export async function refreshOrderIpoTotals(supabase: SupabaseClient, orderId: string): Promise<void> {
  const { data: lines } = await supabase
    .from('vendor_order_line_items')
    .select('attachment_id, line_fee')
    .eq('order_id', orderId)
  const rows = (lines ?? []) as Array<{ attachment_id: string | null; line_fee: number | null }>
  if (!rows.length) return

  const attIds = [...new Set(rows.map(r => r.attachment_id).filter((v): v is string => !!v))]
  if (!attIds.length) return
  const { data: atts } = await supabase
    .from('vendor_order_attachments')
    .select('id, external_ref, created_at')
    .in('id', attIds)
  const parsedAtts = (atts ?? []) as Array<{ id: string; external_ref: string | null; created_at: string }>
  if (!parsedAtts.length) return

  // Newest = highest Clopay documentId (they increment), falling back to when we stored it.
  const rank = (a: { external_ref: string | null }) => {
    const n = Number(a.external_ref)
    return Number.isFinite(n) ? n : 0
  }
  const current = [...parsedAtts].sort((a, b) => rank(b) - rank(a) || b.created_at.localeCompare(a.created_at))[0]

  await supabase.from('vendor_order_line_items').update({ is_current: false })
    .eq('order_id', orderId).neq('attachment_id', current.id)
  await supabase.from('vendor_order_line_items').update({ is_current: true })
    .eq('order_id', orderId).eq('attachment_id', current.id)

  // The order's headline total = the sum of its CURRENT document's lines for THIS order.
  const total = rows.filter(r => r.attachment_id === current.id).reduce((a, r) => a + Number(r.line_fee ?? 0), 0)
  await supabase.from('vendor_orders')
    .update({ derived_total_fee: total, updated_at: new Date().toISOString() })
    .eq('id', orderId)
}

/** Backfill sweep: parse a batch of not-yet-parsed IPO attachments. Idempotent and
 *  resumable — repeated runs drain the backlog, then find nothing to do. */
export async function parsePendingIpoAttachments(limit = 25): Promise<{ processed: number; ok: number; mismatch: number; error: number; recovered: number }> {
  const supabase = db()
  const { data } = await supabase
    .from('vendor_order_attachments')
    .select('id, filename')
    .eq('source', 'clopay_doc')
    .is('parsed_at', null)
    .order('created_at', { ascending: true })
    .limit(limit * 4) // over-fetch: most stored docs are not IPOs
  const all = (data ?? []) as Array<{ id: string; filename: string | null }>
  const targets = all.filter(a => isIpoDoc(a.filename)).slice(0, limit)

  const counts = { processed: 0, ok: 0, mismatch: 0, error: 0, recovered: 0 }
  const skipped = all.filter(a => !isIpoDoc(a.filename)).map(a => a.id)
  if (skipped.length) {
    await supabase.from('vendor_order_attachments')
      .update({ parsed_at: new Date().toISOString(), parse_status: 'not_ipo' })
      .in('id', skipped)
  }

  for (const t of targets) {
    const r = await parseAndStoreIpoAttachment(t.id)
    counts.processed++
    counts.recovered += r.recovered?.length ?? 0
    if (r.status === 'ok') counts.ok++
    else if (r.status === 'mismatch') counts.mismatch++
    else if (r.status === 'error') counts.error++
  }
  return counts
}
