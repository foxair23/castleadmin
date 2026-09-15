import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { downloadVendorDoc } from '@/lib/vendor-orders/attachments'
import { sniffFileType } from '@/lib/files/sniff'

// Throw away a blank whose stored file carries no document, so the Clopay crawler captures
// it again.
//
// Two Clopay blanks arrived as exactly 1,280,000 bytes of zeros. storeVendorDoc now refuses
// such a capture, but rows written before that guard existed are stuck: the crawler skips a
// document it has already stored, so the bad file can never replace itself. Deleting the
// attachment is what unsticks it — the next document crawl sees nothing on file and captures
// the document afresh, and the e-sign row is rebuilt from it automatically.

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}
const BUCKET = 'vendor-order-attachments'

/** Only files carrying no document at all. A scan that arrived as a PNG under a .pdf name IS
 *  the document — the office fills that one in by hand, and deleting it would destroy the
 *  only copy we have. */
const DISCARDABLE = new Set(['zeros', 'empty', 'html'])

export async function discardUnusableBlank(docId: string): Promise<{ ok: boolean; error?: string; filename?: string; kind?: string }> {
  const supabase = db()
  const { data: doc } = await supabase.from('esign_documents').select('id, order_id, status, source_attachment_id, customer_signed_at').eq('id', docId).maybeSingle()
  if (!doc) return { ok: false, error: 'document not found' }
  if (doc.customer_signed_at) return { ok: false, error: 'this one has been signed — it is not a blank any more' }
  if (['completed', 'sf_uploaded', 'portal_uploaded'].includes(doc.status as string)) return { ok: false, error: `nothing to discard at status "${doc.status}"` }
  if (!doc.source_attachment_id) return { ok: false, error: 'no stored file behind this document' }

  const { data: att } = await supabase.from('vendor_order_attachments').select('id, storage_path, filename').eq('id', doc.source_attachment_id as string).maybeSingle()
  if (!att) return { ok: false, error: 'the stored file is already gone' }

  // Read it and check, every time. A button that deletes documents must never take anyone's
  // word — including this app's own error text — for the file being broken.
  const bytes = await downloadVendorDoc(att.storage_path as string)
  if (!bytes) return { ok: false, error: 'could not read the stored file, so it was left alone' }
  const kind = sniffFileType(bytes)
  if (!DISCARDABLE.has(kind)) {
    return { ok: false, error: kind === 'pdf' ? 'this file is a valid PDF — press Prepare instead' : `this file is ${kind === 'jpeg' ? 'a JPEG' : `a ${kind.toUpperCase()}`}, which is still the document — fill it in by hand rather than deleting it` }
  }

  await supabase.storage.from(BUCKET).remove([att.storage_path as string]).catch(() => { /* the row is what blocks the re-capture */ })
  await supabase.from('esign_documents').delete().eq('id', docId)
  const { error } = await supabase.from('vendor_order_attachments').delete().eq('id', att.id as string)
  if (error) return { ok: false, error: error.message }
  await supabase.from('vendor_order_events').insert({
    order_id: doc.order_id, event_type: 'esign_blank_discarded', to_value: kind,
    detail: { doc_id: docId, attachment_id: att.id, filename: att.filename, bytes: bytes.length },
  })
  return { ok: true, filename: (att.filename as string) ?? undefined, kind }
}
