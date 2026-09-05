import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { downloadVendorDoc } from './attachments'
import { isIpoDoc, parseIpoDocument, type IpoParseResult } from './clopay-ipo'
import { loadRateSchedule, variancePatch } from './clopay-rates'

// Turn a stored Clopay IPO PDF into structured line items.
//
// Runs off the stored document (the crawler already captured the bytes), so parsing is
// decoupled from the fragile capture path: a parse failure can never break a doc sync, and
// re-parsing is always possible if the parser improves.
//
// A document may bundle SEVERAL IPOs — one per page, one per order in a multi-door job —
// and Clopay attaches the same bundle to every order in the group. So a section is ALWAYS
// attributed by its own `Order Number`, never by position. The portal line a document hangs
// off owns every order in it: that is the job, and it becomes one SF job. Sections for orders that don't
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
  status: 'ok' | 'mismatch' | 'sibling_doc' | 'error' | 'not_ipo'
  sections?: number
  lines?: number
  totalFee?: number | null
  /** Orders in the document that we had no record of, now recovered. */
  recovered?: string[]
  error?: string
}

/** Clopay's documenT_TYPE for one stored document, read off the order's crawled detail
 *  (`raw.documents[]`, keyed by the same id we store as `external_ref`). */
function docTypeFor(raw: unknown, externalRef: string | null): string | null {
  if (!raw || typeof raw !== 'object' || !externalRef) return null
  const docs = (raw as { documents?: unknown }).documents
  if (!Array.isArray(docs)) return null
  const hit = docs.find(d => d && typeof d === 'object' && String((d as { id?: unknown }).id ?? '') === externalRef)
  const t = hit && (hit as { docType?: unknown }).docType
  return typeof t === 'string' ? t : null
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

  // Which order does this document hang off? Its own section is the authoritative one —
  // and its crawled `raw.documents` carries Clopay's documenT_TYPE, a second signal for
  // "is this an IPO" so classification never rests on the filename convention alone.
  const { data: owner } = await supabase
    .from('vendor_orders').select('id, external_id, vendor, raw').eq('id', att.order_id).maybeSingle()

  const docType = docTypeFor(owner?.raw, att.external_ref as string | null)
  if (!isIpoDoc(att.filename as string | null, docType)) { await stamp('not_ipo', null); return { ok: true, status: 'not_ipo' } }

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

  // Clopay's agreed rates, so each line is stored knowing whether it was paid correctly.
  const rateSchedule = await loadRateSchedule(supabase)

  const recovered: string[] = []
  let storedLines = 0
  let ownerSectionOk: boolean | null = null
  let ownerTotal: number | null = null
  const touchedOrders = new Set<string>()
  // Every order this document ties together. A document sits under ONE portal line, and that
  // line owns everything in it: the orders named in its sections PLUS the order it hangs off,
  // even when the document carries no section of its own for that order. Clopay keys its
  // document list by incident/PO, so an order's IPO can name only its siblings — they are
  // still the same job on the same portal line.
  const groupMembers = new Set<string>()
  if (owner?.vendor === 'clopay_hd') groupMembers.add(owner.id as string)

  for (const sec of sections) {
    if (!sec.orderNumber || sec.items.length === 0) continue
    // Resolve the section to ITS OWN order — never the document's owner by position.
    let orderId: string | null = null
    const { data: match } = await supabase
      .from('vendor_orders').select('id, record_source').eq('vendor', 'clopay_hd').eq('external_id', sec.orderNumber).maybeSingle()
    if (match) {
      orderId = match.id as string
      // Refresh a recovered row's details from the document. These fields were written on
      // insert only, so a parser improvement never reached rows already recovered — the
      // corrected SHIP TO name had nothing to correct ("PIERIK, MAGGIE 56505 HOME DEPOT
      // INC#658" survived the re-parse that fixed the parser). Portal rows are never touched:
      // the crawler's own data is better than anything the IPO carries.
      if (match.record_source === 'ipo_document') {
        await supabase.from('vendor_orders').update({
          customer_po: sec.poNumber,
          order_date: sec.orderDate,
          derived_order_date: sec.orderDate,
          customer_name: sec.customer.customerName,
          street_address: sec.customer.streetAddress,
          city: sec.customer.city,
          state_prov: sec.customer.stateProv,
          postal_code: sec.customer.postalCode,
          phone: sec.customer.phone,
          updated_at: new Date().toISOString(),
        }).eq('id', orderId)
      }
    } else if (owner?.vendor === 'clopay_hd') {
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
    groupMembers.add(orderId)

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
      ...variancePatch(rateSchedule, i.item_number, i.line_fee, i.quantity),
    }))
    const { error: insErr } = await supabase.from('vendor_order_line_items').insert(rows)
    if (!insErr) { storedLines += rows.length; touchedOrders.add(orderId) }

    if (owner && sec.orderNumber === owner.external_id) { ownerSectionOk = sec.ok; ownerTotal = sec.totalFee }
  }

  // A bundle IS the job: link its doors under one primary so the list shows one row per
  // house and autopilot creates one SF job (migration 106).
  const parentId = await linkOrderGroup(supabase, [...groupMembers])
  for (const oid of touchedOrders) await refreshOrderIpoTotals(supabase, oid)
  if (parentId) await rollUpGroupTotal(supabase, parentId)
  // A door can be re-parsed without its group's primary being in the same document; roll the
  // primary up again so its headline number never lags a child's revision.
  for (const oid of touchedOrders) {
    if (oid === parentId) continue
    const { data: kid } = await supabase.from('vendor_orders').select('parent_order_id').eq('id', oid).maybeSingle()
    const pid = kid?.parent_order_id as string | null | undefined
    if (pid && pid !== parentId) await rollUpGroupTotal(supabase, pid)
  }

  // Two very different outcomes, kept apart so neither hides the other:
  //   'mismatch'    — a section's fees didn't sum to its own stated TOTAL. A parser problem.
  //   'sibling_doc' — the document parsed fine but carries no section for the order it hangs
  //                   off. Clopay's document list is keyed by incident/PO, so an order can be
  //                   served only its siblings' IPOs. Nothing is wrong and nothing is lost:
  //                   every section is filed against the order it names, and the whole set is
  //                   grouped under the portal line the document sits on.
  const status: IpoIngestResult['status'] =
    ownerSectionOk === null ? 'sibling_doc' : (ownerSectionOk ? 'ok' : 'mismatch')
  await stamp(status, ownerTotal)
  return { ok: true, status, sections: sections.length, lines: storedLines, totalFee: ownerTotal, recovered }
}

/** Link everything one document ties together into a single group — one portal line, one
 *  job, one SF job. Members are the orders the document names plus the order it hangs off.
 *
 *  Groups MERGE rather than being rebuilt from this document alone: an order already in a
 *  group brings that whole group with it, so a customer whose doors arrive across several
 *  documents ends up in one group instead of the last document winning.
 *
 *  The primary is a portal-sourced order when the group has one — only those carry status,
 *  notes, documents and schedule — with the lowest order number as a stable tie-break, so
 *  re-parsing never reshuffles the group. */
async function linkOrderGroup(supabase: SupabaseClient, memberIds: string[]): Promise<string | null> {
  const ids = new Set(memberIds.filter(Boolean))
  if (ids.size === 0) return null
  if (ids.size === 1) return [...ids][0] // nothing to link; a lone member never reshapes a group

  // Pull in the groups these members already belong to (parents and siblings), transitively.
  let frontier = [...ids]
  for (let round = 0; round < 3 && frontier.length; round++) {
    const [{ data: ups }, { data: downs }] = await Promise.all([
      supabase.from('vendor_orders').select('id, parent_order_id').in('id', frontier),
      supabase.from('vendor_orders').select('id').in('parent_order_id', frontier),
    ])
    const next: string[] = []
    for (const u of (ups ?? []) as Array<{ parent_order_id: string | null }>) {
      if (u.parent_order_id && !ids.has(u.parent_order_id)) { ids.add(u.parent_order_id); next.push(u.parent_order_id) }
    }
    for (const d of (downs ?? []) as Array<{ id: string }>) {
      if (!ids.has(d.id)) { ids.add(d.id); next.push(d.id) }
    }
    frontier = next
  }

  const { data: rows } = await supabase
    .from('vendor_orders').select('id, external_id, record_source').in('id', [...ids])
  const members = (rows ?? []) as Array<{ id: string; external_id: string | null; record_source: string | null }>
  if (members.length < 2) return members[0]?.id ?? [...ids][0]

  // record_source, not "a row already existed" — a door recovered by an earlier document has
  // a row too, and counting that as a portal order let a status-less recovered row become the
  // primary while the real portal order hung off it as a child.
  const sorted = [...members].sort((a, b) =>
    (b.record_source === 'portal' ? 1 : 0) - (a.record_source === 'portal' ? 1 : 0)
    || (a.external_id ?? '').localeCompare(b.external_id ?? ''))
  const parent = sorted[0]
  const children = sorted.slice(1).map(m => m.id)

  await supabase.from('vendor_orders').update({ parent_order_id: null }).eq('id', parent.id)
  await supabase.from('vendor_orders').update({ parent_order_id: parent.id }).in('id', children)
  return parent.id
}

/** The primary carries the WHOLE job's money — that's what the single SF job is worth —
 *  while each door keeps its own total for the per-door breakdown. */
async function rollUpGroupTotal(supabase: SupabaseClient, parentId: string): Promise<void> {
  const { data: kids } = await supabase
    .from('vendor_orders').select('derived_total_fee').eq('parent_order_id', parentId)
  const rows = (kids ?? []) as Array<{ derived_total_fee: number | null }>
  if (!rows.length) return // not a group
  // Recompute the primary's OWN door from its line items rather than reading back
  // derived_total_fee — that column already holds a roll-up, so adding the children to it
  // would compound the group total a little more on every re-parse.
  const { data: ownLines } = await supabase
    .from('vendor_order_line_items').select('line_fee').eq('order_id', parentId).eq('is_current', true)
  const own = ((ownLines ?? []) as Array<{ line_fee: number | null }>)
    .reduce((a, r) => a + Number(r.line_fee ?? 0), 0)
  const total = own + rows.reduce((a, r) => a + Number(r.derived_total_fee ?? 0), 0)
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
 *  resumable — repeated runs drain the backlog, then find nothing to do.
 *
 *  Reports `candidates` and `skipped` separately from `processed`: a run that finds nothing
 *  it RECOGNIZES looks identical to a run with nothing to do unless those are distinct, and
 *  that ambiguity is exactly what hid a broken filename matcher for a day. */
export interface IpoSweepCounts {
  candidates: number
  skipped: number
  processed: number
  ok: number
  mismatch: number
  error: number
  recovered: number
  remaining: number
}

export async function parsePendingIpoAttachments(limit = 25): Promise<IpoSweepCounts> {
  const supabase = db()
  const { data } = await supabase
    .from('vendor_order_attachments')
    .select('id, order_id, filename, external_ref')
    .eq('source', 'clopay_doc')
    .is('parsed_at', null)
    .order('created_at', { ascending: true })
    .limit(limit * 4) // over-fetch: most stored docs are not IPOs
  const all = (data ?? []) as Array<{ id: string; order_id: string; filename: string | null; external_ref: string | null }>

  const byName = all.filter(a => isIpoDoc(a.filename))
  const misses = all.filter(a => !isIpoDoc(a.filename))
  // Second chance on Clopay's own documenT_TYPE before we write anything off.
  const rescued = await rescueByDocType(supabase, misses)

  const candidates = [...byName, ...misses.filter(m => rescued.has(m.id))]
  const targets = candidates.slice(0, limit)
  const skipped = misses.filter(m => !rescued.has(m.id)).map(a => a.id)

  const counts: IpoSweepCounts = {
    candidates: candidates.length, skipped: skipped.length,
    processed: 0, ok: 0, mismatch: 0, error: 0, recovered: 0, remaining: 0,
  }
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

  const { count } = await supabase
    .from('vendor_order_attachments')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'clopay_doc')
    .is('parsed_at', null)
  counts.remaining = count ?? 0
  return counts
}

/** Attachments whose filename didn't look like an IPO but whose order says otherwise.
 *  Only the misses' orders are loaded (their `raw` is large), so the common case costs
 *  nothing extra. */
async function rescueByDocType(
  supabase: SupabaseClient,
  misses: Array<{ id: string; order_id: string; filename: string | null; external_ref: string | null }>,
): Promise<Set<string>> {
  const hits = new Set<string>()
  if (!misses.length) return hits
  const orderIds = [...new Set(misses.map(m => m.order_id).filter(Boolean))]
  if (!orderIds.length) return hits
  const { data } = await supabase.from('vendor_orders').select('id, raw').in('id', orderIds)
  const rawById = new Map((data ?? []).map(o => [String(o.id), (o as { raw?: unknown }).raw]))
  for (const m of misses) {
    if (isIpoDoc(m.filename, docTypeFor(rawById.get(m.order_id), m.external_ref))) hits.add(m.id)
  }
  return hits
}
