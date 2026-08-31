import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { downloadVendorDoc } from './attachments'
import { isIpoDoc, parseIpoText, type IpoParseResult } from './clopay-ipo'

// Turn a stored Clopay IPO PDF into structured line items.
//
// Runs off the stored document (the crawler already captured the bytes), so parsing is
// decoupled from the fragile capture path: a parse failure can never break a doc sync, and
// re-parsing is always possible if the parser improves. Per document we record the outcome
// (`parse_status`) — the IPO's own TOTAL line is the checksum, so a bad parse shows as
// 'mismatch' rather than silently wrong money.

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

/** Clopay's Oracle generator pads PDFs out to a fixed size (many are exactly 1,280,000
 *  bytes). The padding is valid-but-pointless trailing bytes; trimming past the last %%EOF
 *  keeps the PDF reader from having to chew through ~1MB of filler. */
function trimPdfPadding(bytes: Uint8Array): Uint8Array {
  const idx = Buffer.from(bytes).lastIndexOf(Buffer.from('%%EOF'))
  return idx > 0 ? bytes.slice(0, idx + 5) : bytes
}

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  // Imported lazily so the PDF engine is only loaded on the parse path.
  const { extractText, getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(trimPdfPadding(bytes))
  const { text } = await extractText(pdf, { mergePages: true })
  return typeof text === 'string' ? text : String(text ?? '')
}

export interface IpoIngestResult {
  ok: boolean
  status: 'ok' | 'mismatch' | 'error' | 'not_ipo'
  lines?: number
  totalFee?: number | null
  error?: string
}

/** Parse one stored attachment and persist its line items. Never throws — the outcome is
 *  recorded on the attachment so the backfill can move on and problems stay visible. */
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

  let parsed: IpoParseResult
  try {
    const bytes = await downloadVendorDoc(att.storage_path as string)
    if (!bytes) { await stamp('error', null); return { ok: false, status: 'error', error: 'download failed' } }
    parsed = parseIpoText(await extractPdfText(bytes))
  } catch (e) {
    await stamp('error', null)
    return { ok: false, status: 'error', error: e instanceof Error ? e.message : String(e) }
  }

  if (parsed.items.length === 0) { await stamp('error', parsed.totalFee); return { ok: false, status: 'error', error: 'no line items found' } }

  // Replace this document's rows (re-parsing must not duplicate).
  await supabase.from('vendor_order_line_items').delete().eq('attachment_id', att.id)
  const rows = parsed.items.map((i, n) => ({
    order_id: att.order_id,
    attachment_id: att.id,
    source_document_ref: att.external_ref ?? null,
    line_no: i.line_no,
    quantity: i.quantity,
    item_number: i.item_number,
    description: i.description,
    line_fee: i.line_fee,
    sort_order: n,
  }))
  const { error: insErr } = await supabase.from('vendor_order_line_items').insert(rows)
  if (insErr) { await stamp('error', parsed.totalFee); return { ok: false, status: 'error', error: insErr.message } }

  const status: IpoIngestResult['status'] = parsed.ok ? 'ok' : 'mismatch'
  await stamp(status, parsed.totalFee)
  await refreshOrderIpoTotals(supabase, att.order_id as string)
  return { ok: true, status, lines: rows.length, totalFee: parsed.totalFee }
}

/** Point an order at its CURRENT IPO: a change order produces a revised IPO that restates
 *  the whole order, so the newest successfully parsed document wins. Older documents keep
 *  their line items (history) but are flagged is_current=false. */
export async function refreshOrderIpoTotals(supabase: SupabaseClient, orderId: string): Promise<void> {
  const { data: atts } = await supabase
    .from('vendor_order_attachments')
    .select('id, external_ref, parsed_total_fee, parse_status, created_at')
    .eq('order_id', orderId)
    .in('parse_status', ['ok', 'mismatch'])
  const parsedAtts = (atts ?? []) as Array<{ id: string; external_ref: string | null; parsed_total_fee: number | null; parse_status: string; created_at: string }>
  if (!parsedAtts.length) return

  // Newest = highest Clopay documentId (they increment), falling back to when we stored it.
  const rank = (a: { external_ref: string | null; created_at: string }) => {
    const n = Number(a.external_ref)
    return Number.isFinite(n) ? n : 0
  }
  const current = [...parsedAtts].sort((a, b) => rank(b) - rank(a) || b.created_at.localeCompare(a.created_at))[0]

  await supabase.from('vendor_order_line_items').update({ is_current: false }).eq('order_id', orderId).neq('attachment_id', current.id)
  await supabase.from('vendor_order_line_items').update({ is_current: true }).eq('attachment_id', current.id)
  await supabase.from('vendor_orders')
    .update({ derived_total_fee: current.parsed_total_fee, updated_at: new Date().toISOString() })
    .eq('id', orderId)
}

/** Backfill sweep: parse a batch of not-yet-parsed IPO attachments. Idempotent and
 *  resumable — repeated runs drain the backlog, then find nothing to do. */
export async function parsePendingIpoAttachments(limit = 25): Promise<{ processed: number; ok: number; mismatch: number; error: number }> {
  const supabase = db()
  const { data } = await supabase
    .from('vendor_order_attachments')
    .select('id, filename')
    .eq('source', 'clopay_doc')
    .is('parsed_at', null)
    .order('created_at', { ascending: true })
    .limit(limit * 4) // over-fetch: most stored docs are not IPOs
  const targets = ((data ?? []) as Array<{ id: string; filename: string | null }>)
    .filter(a => isIpoDoc(a.filename))
    .slice(0, limit)

  const counts = { processed: 0, ok: 0, mismatch: 0, error: 0 }
  // Mark the non-IPOs we skipped so they stop showing up in future sweeps.
  const skipped = ((data ?? []) as Array<{ id: string; filename: string | null }>)
    .filter(a => !isIpoDoc(a.filename)).map(a => a.id)
  if (skipped.length) {
    await supabase.from('vendor_order_attachments')
      .update({ parsed_at: new Date().toISOString(), parse_status: 'not_ipo' })
      .in('id', skipped)
  }

  for (const t of targets) {
    const r = await parseAndStoreIpoAttachment(t.id)
    counts.processed++
    if (r.status === 'ok') counts.ok++
    else if (r.status === 'mismatch') counts.mismatch++
    else if (r.status === 'error') counts.error++
  }
  return counts
}
