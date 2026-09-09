import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { docMetaFor } from '@/lib/vendor-orders/ipo-ingest'
import { ensureEsignDocForAttachment } from './documents'

// Documents stored before the crawl carried docType/raw_name — every one on file today —
// have neither. Their order's crawled detail (raw.documents[]) still has both, keyed by the
// same id we keep as external_ref. Fill them in, then classify. Runs from the nightly IPO
// cron in budgeted batches; each attachment is stamped once (esign_doc_type), so re-runs
// only ever touch what is new.

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export interface ClassifyCounts { looked: number; lien_waiver: number; signed: number; none: number; remaining: number }

export async function classifyPendingAttachments(limit = 100): Promise<ClassifyCounts> {
  const supabase = db()
  const counts: ClassifyCounts = { looked: 0, lien_waiver: 0, signed: 0, none: 0, remaining: 0 }
  const { data } = await supabase.from('vendor_order_attachments')
    .select('id, order_id, filename, external_ref, doc_type, raw_name')
    .eq('source', 'clopay_doc').is('esign_doc_type', null)
    .order('created_at', { ascending: true }).limit(limit)
  const rows = (data ?? []) as Array<{ id: string; order_id: string; filename: string | null; external_ref: string | null; doc_type: string | null; raw_name: string | null }>
  if (!rows.length) return counts

  // Fill doc_type / raw_name from the order's crawled detail where the row lacks them.
  const needMeta = rows.filter(r => !r.doc_type || !r.raw_name)
  if (needMeta.length) {
    const orderIds = [...new Set(needMeta.map(r => r.order_id))]
    const { data: orders } = await supabase.from('vendor_orders').select('id, raw').in('id', orderIds)
    const rawById = new Map((orders ?? []).map(o => [String(o.id), (o as { raw?: unknown }).raw]))
    for (const r of needMeta) {
      const meta = docMetaFor(rawById.get(r.order_id), r.external_ref)
      const patch: Record<string, string> = {}
      if (!r.doc_type && meta.docType) patch.doc_type = meta.docType
      if (!r.raw_name && meta.name) patch.raw_name = meta.name
      if (Object.keys(patch).length) await supabase.from('vendor_order_attachments').update(patch).eq('id', r.id)
    }
  }

  for (const r of rows) {
    const res = await ensureEsignDocForAttachment(r.id, supabase)
    counts.looked++
    if (res.kind === 'lien_waiver') counts.lien_waiver++
    else if (res.kind === 'lien_waiver_signed') counts.signed++
    else counts.none++
  }
  const { count } = await supabase.from('vendor_order_attachments').select('id', { count: 'exact', head: true }).eq('source', 'clopay_doc').is('esign_doc_type', null)
  counts.remaining = count ?? 0
  return counts
}
