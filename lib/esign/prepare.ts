import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { downloadVendorDoc } from '@/lib/vendor-orders/attachments'
import { inspectPdf, fingerprintPdf, renderPrepared, renderOverlay, type PdfInspection } from './render'
import { resolveTemplate, templateByKey, type TemplateSpec } from './templates'
import { buildPrefill, type PrefillOrder, type PrefillJob } from './prefill'

// From "found" to "prepared": download the blank, work out which form version it is, fill it
// from the order and job, store the result. A version the registry does not know is held as
// `unrecognised_template` — with its fingerprint recorded so the Templates page can list it —
// and is retried on every sweep, so pinning the layout is all it takes to unblock it.

const BUCKET = 'vendor-order-attachments'

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

const ORDER_COLS = 'id, parent_order_id, external_id, customer_name, customer_po, street_address, city, state_prov, postal_code, sf_job_id'

async function loadContext(supabase: SupabaseClient, docId: string) {
  const { data: doc } = await supabase.from('esign_documents').select('*').eq('id', docId).maybeSingle()
  if (!doc) return null
  const { data: att } = await supabase.from('vendor_order_attachments').select('id, storage_path').eq('id', doc.source_attachment_id as string).maybeSingle()
  const { data: root } = await supabase.from('vendor_orders').select(ORDER_COLS).eq('id', doc.order_id as string).maybeSingle()
  const { data: kids } = await supabase.from('vendor_orders').select(ORDER_COLS).eq('parent_order_id', doc.order_id as string)
  const sfJobId = (root?.sf_job_id as string | null) ?? (doc.sf_job_id as string | null)
  const { data: job } = sfJobId ? await supabase.from('sf_jobs').select('number, start_date').eq('id', sfJobId).maybeSingle() : { data: null }
  return { doc, att, root: root as PrefillOrder | null, doors: (kids ?? []) as PrefillOrder[], job: job as PrefillJob | null, sfJobId }
}

export interface PrepareResult { ok: boolean; status?: string; fingerprint?: string; template?: string | null; error?: string }

export async function prepareEsignDoc(docId: string, supabase: SupabaseClient = db()): Promise<PrepareResult> {
  const ctx = await loadContext(supabase, docId)
  if (!ctx) return { ok: false, error: 'esign document not found' }
  const { doc, att, root, doors, job, sfJobId } = ctx
  if (!att || !root) return { ok: false, error: 'source attachment or order missing' }
  const now = new Date().toISOString()
  try {
    const bytes = await downloadVendorDoc(att.storage_path as string)
    if (!bytes) throw new Error('could not download the blank')
    const insp = await inspectPdf(bytes)
    const fingerprint = fingerprintPdf(insp)
    const template = resolveTemplate(fingerprint, insp.firstPageText)
    if (!template) {
      await supabase.from('esign_documents').update({ status: 'unrecognised_template', template_fingerprint: fingerprint, template_key: null, sf_job_id: sfJobId, error: null, updated_at: now }).eq('id', docId)
      return { ok: true, status: 'unrecognised_template', fingerprint, template: null }
    }
    const prefill = buildPrefill(root, doors, job)
    const filled = await renderPrepared(bytes, template, prefill)
    const path = `${doc.order_id}/esign/${docId}/prepared.pdf`
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, filled, { contentType: 'application/pdf', upsert: true })
    if (upErr) throw new Error(upErr.message)
    await supabase.from('esign_documents').update({
      status: 'prepared', template_key: template.key, template_fingerprint: fingerprint, prefill, prepared_pdf_path: path, sf_job_id: sfJobId, error: null, updated_at: now,
    }).eq('id', docId)
    await supabase.from('vendor_order_events').insert({ order_id: doc.order_id, event_type: 'esign_prepared', to_value: template.key, detail: { fingerprint } })
    return { ok: true, status: 'prepared', fingerprint, template: template.key }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await supabase.from('esign_documents').update({ error, updated_at: now }).eq('id', docId)
    return { ok: false, error }
  }
}

/** Sweep: prepare what is 'found', and retry 'unrecognised_template' rows whose fingerprint
 *  the registry now knows (pinning a layout unblocks them without touching the database). */
export async function preparePendingEsignDocs(limit = 50): Promise<{ looked: number; prepared: number; unrecognised: number; failed: number }> {
  const supabase = db()
  const out = { looked: 0, prepared: 0, unrecognised: 0, failed: 0 }
  const { data } = await supabase.from('esign_documents').select('id, status, template_fingerprint')
    .in('status', ['found', 'unrecognised_template']).order('created_at', { ascending: true }).limit(limit * 3)
  for (const d of (data ?? []) as Array<{ id: string; status: string; template_fingerprint: string | null }>) {
    if (out.looked >= limit) break
    // A held row is retried only when the registry might now know it: a fingerprint match is
    // checked here for free; a marker match needs the text, so rows are retried a few at a time.
    if (d.status === 'unrecognised_template' && d.template_fingerprint && !resolveTemplate(d.template_fingerprint) && out.looked >= Math.ceil(limit / 5)) continue
    out.looked++
    const r = await prepareEsignDoc(d.id, supabase)
    if (!r.ok) out.failed++
    else if (r.status === 'prepared') out.prepared++
    else out.unrecognised++
  }
  return out
}

/** For the Templates page: what one blank looks like inside. */
export async function inspectEsignDoc(docId: string): Promise<{ ok: boolean; inspection?: PdfInspection; fingerprint?: string; template?: TemplateSpec | null; error?: string }> {
  const supabase = db()
  const ctx = await loadContext(supabase, docId)
  if (!ctx?.att) return { ok: false, error: 'not found' }
  const bytes = await downloadVendorDoc(ctx.att.storage_path as string)
  if (!bytes) return { ok: false, error: 'could not download' }
  const inspection = await inspectPdf(bytes)
  const fingerprint = fingerprintPdf(inspection)
  return { ok: true, inspection, fingerprint, template: resolveTemplate(fingerprint, inspection.firstPageText) }
}

/** The blank, pre-filled where a template exists, with every box outlined and a coordinate
 *  ruler — the picture a layout is pinned from. `candidate` lets a layout be tried before it
 *  is registered. */
export async function previewEsignDoc(docId: string, candidate?: Pick<TemplateSpec, 'fields'>): Promise<{ ok: boolean; bytes?: Uint8Array; error?: string }> {
  const supabase = db()
  const ctx = await loadContext(supabase, docId)
  if (!ctx?.att || !ctx.root) return { ok: false, error: 'not found' }
  const bytes = await downloadVendorDoc(ctx.att.storage_path as string)
  if (!bytes) return { ok: false, error: 'could not download' }
  const insp = await inspectPdf(bytes)
  const template = candidate ? { key: 'candidate', vendor: '', docType: '', label: '', fingerprints: [], fields: candidate.fields } : (templateByKey(ctx.doc.template_key as string | null) ?? resolveTemplate(fingerprintPdf(insp), insp.firstPageText))
  const filled = template ? await renderPrepared(bytes, template, buildPrefill(ctx.root, ctx.doors, ctx.job)) : bytes
  return { ok: true, bytes: await renderOverlay(filled, { fields: template?.fields ?? [] }) }
}
