import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { downloadVendorDoc } from '@/lib/vendor-orders/attachments'
import { sendEmail } from '@/lib/notifications/resend'
import { enqueueSfDocumentUpload } from '@/lib/sf-documents/queue'
import { renderCompleted } from './render'
import { templateByKey } from './templates'
import { greetingFirstName } from '@/lib/names'

// Both signatures are in: produce the finished form, give the customer their copy, and
// hand it to the extension to file on the SF job. The Clopay portal upload is a person's
// job (Action Items → "Uploaded to Clopay"), auto-cleared when the crawl sees the Signed
// ICA/LW come back. Idempotent: a document already completed is left alone.

const BUCKET = 'vendor-order-attachments'
function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export interface FinalizeResult { ok: boolean; status?: string; error?: string; emailed?: boolean; queued?: boolean }

export async function finalizeEsignDoc(docId: string, supabase: SupabaseClient = db()): Promise<FinalizeResult> {
  const { data: doc } = await supabase.from('esign_documents').select('*').eq('id', docId).maybeSingle()
  if (!doc) return { ok: false, error: 'Document not found.' }
  if (['completed', 'sf_uploaded', 'portal_uploaded'].includes(doc.status as string)) return { ok: true, status: doc.status as string }
  if (doc.status !== 'tech_signed') return { ok: false, error: `Not ready to finalize at status "${doc.status}".` }
  const template = templateByKey(doc.template_key as string | null)
  if (!template) return { ok: false, error: 'No template for this document.' }
  const now = new Date().toISOString()
  try {
    const [prepared, custPng, techPng] = await Promise.all([
      downloadVendorDoc(doc.prepared_pdf_path as string),
      downloadVendorDoc(doc.customer_sig_path as string),
      downloadVendorDoc(doc.tech_sig_path as string),
    ])
    if (!prepared || !custPng || !techPng) throw new Error('prepared PDF or a signature file is missing from storage')
    const bytes = await renderCompleted(prepared, template, {
      customer: { png: custPng, name: doc.customer_signed_name as string, at: doc.customer_signed_at as string, ip: doc.customer_ip as string | null },
      tech: { png: techPng, name: doc.tech_signed_name as string, at: doc.tech_signed_at as string, ip: doc.tech_ip as string | null },
      customerFields: (doc.customer_fields ?? {}) as Record<string, string>,
    })
    const path = `${doc.order_id}/esign/${docId}/completed.pdf`
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, bytes, { contentType: 'application/pdf', upsert: true })
    if (upErr) throw new Error(upErr.message)

    const prefill = (doc.prefill ?? {}) as Record<string, string>
    const service = template.service
    const filename = `${service === 'delivery' ? 'HD-Proof-of-Delivery' : 'HD-Completion-Form'}-${prefill.sf_job_number || prefill.order_number || docId.slice(0, 8)}-signed.pdf`
    // Conditional: only the row still at tech_signed moves; a concurrent finalize loses quietly.
    const { data: moved } = await supabase.from('esign_documents').update({ status: 'completed', completed_pdf_path: path, completed_at: now, error: null, updated_at: now }).eq('id', docId).eq('status', 'tech_signed').select('id')
    if (!moved?.length) return { ok: true, status: 'completed' }
    await supabase.from('vendor_order_events').insert({ order_id: doc.order_id, event_type: 'esign_completed', to_value: path, detail: { doc_id: docId } })
    // Show it with the order's Documents, alongside the blank it came from.
    const { error: attErr } = await supabase.from('vendor_order_attachments').insert({
      order_id: doc.order_id, storage_path: path, filename, mime_type: 'application/pdf', byte_size: bytes.byteLength, source: 'esign', external_ref: `esign:${docId}:completed`, esign_doc_type: 'none',
    })
    if (attErr && !/duplicate key|unique/i.test(attErr.message)) console.warn('[esign] attachment row', attErr.message)

    // The customer's copy.
    let emailed = false
    const { data: order } = await supabase.from('vendor_orders').select('email, customer_name').eq('id', doc.order_id as string).maybeSingle()
    if (order?.email) {
      try {
        const hi = greetingFirstName({ customerName: order.customer_name as string | null })
        const what = service === 'delivery' ? 'Home Depot proof-of-delivery form' : 'Home Depot completion form'
        const text = `${hi ? `Hi ${hi},` : 'Hi,'}\n\nThank you — your ${what} is complete and signed by you and your technician. A copy is attached for your records.\n\nQuestions? Call us at (800) 576-1397 or just reply to this email.\n\n— Castle Team`
        await sendEmail({ to: order.email as string, subject: `Your signed ${what} — copy for your records`, text, html: `<p style="font-family:system-ui;font-size:16px;line-height:1.6;white-space:pre-line">${text.replace(/</g, '&lt;')}</p>`, attachments: [{ filename, content: bytes }] })
        emailed = true
      } catch (e) { console.error('[esign] customer copy', e) }
    }

    // File it on the SF job through the extension.
    let queued = false
    const sfJobId = doc.sf_job_id as string | null
    if (sfJobId) {
      const r = await enqueueSfDocumentUpload({ sfJobId, sfJobNumber: prefill.sf_job_number ?? null, storagePath: path, filename, dedupKey: `esign:${docId}:completed`, refTable: 'esign_documents', refId: docId })
      queued = r.ok
    }
    return { ok: true, status: 'completed', emailed, queued }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await supabase.from('esign_documents').update({ error, updated_at: now }).eq('id', docId)
    return { ok: false, error }
  }
}

/** Sweep: anything tech-signed that finalize missed (a crash mid-way, a storage hiccup). */
export async function runEsignFinalizeSweep(): Promise<{ looked: number; completed: number; failed: number }> {
  const supabase = db()
  const out = { looked: 0, completed: 0, failed: 0 }
  const { data } = await supabase.from('esign_documents').select('id').eq('status', 'tech_signed').limit(25)
  for (const d of data ?? []) {
    out.looked++
    const r = await finalizeEsignDoc(d.id as string, supabase)
    if (r.ok) out.completed++; else out.failed++
  }
  return out
}

/** A person uploaded the completed form to the Clopay portal (Action Items button). */
export async function markEsignPortalUploaded(docId: string, byName: string | null, supabase: SupabaseClient = db()): Promise<{ ok: boolean; error?: string }> {
  const { data: doc } = await supabase.from('esign_documents').select('id, order_id, status').eq('id', docId).maybeSingle()
  if (!doc) return { ok: false, error: 'Document not found.' }
  if (doc.status === 'portal_uploaded') return { ok: true }
  if (!['completed', 'sf_uploaded'].includes(doc.status as string)) return { ok: false, error: `Not completed yet (status "${doc.status}").` }
  const now = new Date().toISOString()
  await supabase.from('esign_documents').update({ status: 'portal_uploaded', portal_uploaded_at: now, portal_uploaded_by: byName ?? 'office', updated_at: now }).eq('id', docId)
  await supabase.from('vendor_order_events').insert({ order_id: doc.order_id, event_type: 'esign_portal_uploaded', to_value: byName ?? 'office', detail: { doc_id: docId } })
  return { ok: true }
}
