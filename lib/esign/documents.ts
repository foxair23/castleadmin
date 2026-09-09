import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { classifyVendorDoc, type EsignDocKind } from './classify'
import { generateApprovalToken } from '@/lib/approvals/acceptance'

// The esign_documents lifecycle, from the crawl's side: a stored vendor document is
// classified, and a blank lien waiver becomes an esign row on its HOUSE (the root order —
// a multi-door group is one job, one waiver). A signed waiver coming back from the portal
// closes the loop on that row. Nothing here sends anything.

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export const ESIGN_DOC_TYPE_FOR: Partial<Record<EsignDocKind, string>> = { lien_waiver: 'lien_waiver' }

/** Statuses before anything customer-facing has happened: the blank may be swapped for a
 *  newer copy without losing anything. */
const REPLACEABLE = new Set(['found', 'unrecognised_template', 'prepared'])

export interface EnsureResult { kind: EsignDocKind; docId?: string; action: 'created' | 'updated' | 'closed' | 'noop' }

/** Classify one stored attachment and act on it. Idempotent: re-running on the same
 *  attachment changes nothing the second time. */
export async function ensureEsignDocForAttachment(attachmentId: string, supabase: SupabaseClient = db(), opts: { forceKind?: EsignDocKind } = {}): Promise<EnsureResult> {
  const { data: att } = await supabase.from('vendor_order_attachments')
    .select('id, order_id, filename, raw_name, doc_type, esign_doc_type, source')
    .eq('id', attachmentId).maybeSingle()
  if (!att) return { kind: 'none', action: 'noop' }
  const { data: order } = await supabase.from('vendor_orders').select('id, vendor, parent_order_id, sf_job_id').eq('id', att.order_id as string).maybeSingle()
  if (!order) return { kind: 'none', action: 'noop' }

  const kind = opts.forceKind ?? classifyVendorDoc(order.vendor as string, (att.raw_name as string | null) ?? (att.filename as string | null), att.doc_type as string | null)
  if (att.esign_doc_type !== kind) await supabase.from('vendor_order_attachments').update({ esign_doc_type: kind }).eq('id', attachmentId)
  if (kind === 'none') return { kind, action: 'noop' }

  const rootId = (order.parent_order_id as string | null) ?? (order.id as string)
  if (kind === 'lien_waiver_signed') return markPortalUploadedFromSignedDoc(rootId, attachmentId, supabase)

  const docType = ESIGN_DOC_TYPE_FOR[kind]!
  const { data: existing } = await supabase.from('esign_documents').select('id, status, source_attachment_id').eq('order_id', rootId).eq('doc_type', docType).maybeSingle()
  const now = new Date().toISOString()
  if (existing) {
    if (existing.source_attachment_id === attachmentId) return { kind, docId: existing.id as string, action: 'noop' }
    if (!REPLACEABLE.has(existing.status as string)) return { kind, docId: existing.id as string, action: 'noop' }
    // A newer blank for a house we have not sent anything for yet: use it, and start over
    // from 'found' so it gets inspected and prepared again.
    await supabase.from('esign_documents').update({ source_attachment_id: attachmentId, status: 'found', template_key: null, template_fingerprint: null, prepared_pdf_path: null, updated_at: now }).eq('id', existing.id)
    await supabase.from('vendor_order_events').insert({ order_id: rootId, event_type: 'esign_found', to_value: docType, detail: { attachment_id: attachmentId, replaced: existing.source_attachment_id } })
    return { kind, docId: existing.id as string, action: 'updated' }
  }

  const { data: created, error } = await supabase.from('esign_documents').insert({
    vendor: order.vendor, doc_type: docType, order_id: rootId, source_attachment_id: attachmentId,
    sf_job_id: (order.sf_job_id as string | null) ?? null, status: 'found',
    customer_token: generateApprovalToken(), tech_token: generateApprovalToken(),
  }).select('id').single()
  if (error) {
    // Two doors of one house stored in the same second: the other insert won. Fine.
    if (/duplicate key|unique/i.test(error.message)) return { kind, action: 'noop' }
    throw new Error(error.message)
  }
  await supabase.from('vendor_order_events').insert({ order_id: rootId, event_type: 'esign_found', to_value: docType, detail: { attachment_id: attachmentId } })
  return { kind, docId: created.id as string, action: 'created' }
}

/** A "Signed ICA/LW" appeared on the order — the portal upload happened (by us or by hand).
 *  Records it; closes the esign row when it was waiting on exactly that. No esign row (the
 *  office handled the whole thing manually) → nothing to do. */
export async function markPortalUploadedFromSignedDoc(rootId: string, attachmentId: string, supabase: SupabaseClient = db()): Promise<EnsureResult> {
  const { data: doc } = await supabase.from('esign_documents').select('id, status, signed_attachment_id').eq('order_id', rootId).eq('doc_type', 'lien_waiver').maybeSingle()
  if (!doc) return { kind: 'lien_waiver_signed', action: 'noop' }
  const now = new Date().toISOString()
  const closing = doc.status === 'completed' || doc.status === 'sf_uploaded'
  await supabase.from('esign_documents').update({
    signed_attachment_id: attachmentId, updated_at: now,
    ...(closing ? { status: 'portal_uploaded', portal_uploaded_at: now, portal_uploaded_by: 'portal:signed_doc' } : {}),
  }).eq('id', doc.id)
  if (closing) await supabase.from('vendor_order_events').insert({ order_id: rootId, event_type: 'esign_portal_uploaded', to_value: 'portal:signed_doc', detail: { attachment_id: attachmentId } })
  return { kind: 'lien_waiver_signed', docId: doc.id as string, action: closing ? 'closed' : 'noop' }
}

export interface EsignDocSummary {
  id: string; order_id: string; vendor: string; doc_type: string; status: string; template_key: string | null
  customer_sent_at: string | null; customer_asked_at: string | null; customer_signed_at: string | null
  tech_name: string | null; tech_sent_at: string | null; tech_signed_at: string | null
  completed_at: string | null; sf_uploaded_at: string | null; portal_uploaded_at: string | null; portal_uploaded_by: string | null
  prepared_pdf_path: string | null; completed_pdf_path: string | null; error: string | null; created_at: string
}

/** Esign rows for a set of (root) order ids, for the HD Orders drawer and the Signatures tab. */
export async function esignDocsForOrders(orderIds: string[], supabase: SupabaseClient = db()): Promise<Map<string, EsignDocSummary[]>> {
  const map = new Map<string, EsignDocSummary[]>()
  if (!orderIds.length) return map
  const { data } = await supabase.from('esign_documents')
    .select('id, order_id, vendor, doc_type, status, template_key, customer_sent_at, customer_asked_at, customer_signed_at, tech_name, tech_sent_at, tech_signed_at, completed_at, sf_uploaded_at, portal_uploaded_at, portal_uploaded_by, prepared_pdf_path, completed_pdf_path, error, created_at')
    .in('order_id', orderIds)
  for (const r of (data ?? []) as EsignDocSummary[]) {
    const arr = map.get(r.order_id) ?? []
    arr.push(r); map.set(r.order_id, arr)
  }
  return map
}

/** Cancel (or restore) a document. Cancelled rows are ignored by every sweep and both links
 *  say "no longer needed". Restore puts it back to 'found' so it is inspected afresh. */
export async function cancelEsignDoc(docId: string, restore = false, supabase: SupabaseClient = db()): Promise<{ ok: boolean; error?: string }> {
  const { data: doc } = await supabase.from('esign_documents').select('id, order_id, status').eq('id', docId).maybeSingle()
  if (!doc) return { ok: false, error: 'Document not found.' }
  if (!restore && ['sf_uploaded', 'portal_uploaded'].includes(doc.status as string)) return { ok: false, error: 'Already filed — nothing to cancel.' }
  if (restore && doc.status !== 'cancelled') return { ok: false, error: 'Not cancelled.' }
  const now = new Date().toISOString()
  await supabase.from('esign_documents').update({ status: restore ? 'found' : 'cancelled', updated_at: now }).eq('id', docId)
  await supabase.from('vendor_order_events').insert({ order_id: doc.order_id, event_type: restore ? 'esign_restored' : 'esign_cancelled', to_value: restore ? 'found' : 'cancelled', detail: { doc_id: docId, from_status: doc.status } })
  return { ok: true }
}
