import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { signedUrl } from '@/lib/vendor-orders/attachments'
import { enqueueForSubscribers } from '@/lib/notifications/enqueue'
import { appUrl } from '@/lib/config/domains'

// Queue of files for the Chrome extension to upload onto Service Fusion jobs. SF's REST API
// has no document endpoint at all, so — like notes, line items and appointments — the app
// queues WHAT and the extension does it through SF's web session.
//
// The exact upload request SF's job page makes has not been captured yet. Until it is, the
// extension runs DISCOVERY on each item: it opens the job page, records what the upload
// widget is configured with, and reports that back here (`discovery`) without uploading.
// Such an item stays pending and is not counted as a failure; once the real request is
// known and shipped in the extension, the same queue drives the upload.

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}
const MAX_ATTEMPTS = 5

export async function enqueueSfDocumentUpload(input: { sfJobId: string; sfJobNumber: string | null; storagePath: string; filename: string; dedupKey: string; refTable?: string; refId?: string }): Promise<{ ok: boolean; error?: string }> {
  const { error } = await db().from('sf_document_upload_queue').upsert(
    { sf_job_id: input.sfJobId, sf_job_number: input.sfJobNumber, storage_path: input.storagePath, filename: input.filename, dedup_key: input.dedupKey, ref_table: input.refTable ?? null, ref_id: input.refId ?? null },
    { onConflict: 'dedup_key', ignoreDuplicates: true },
  )
  return error ? { ok: false, error: error.message } : { ok: true }
}

export interface SfDocQueueItem { id: string; sfJobId: string; jobNumber: string | null; filename: string; downloadUrl: string; discovered: boolean }

/** Pending uploads. Each carries a fresh one-hour download URL — the bytes never pass
 *  through Vercel; the extension fetches them straight from storage. */
export async function getSfDocumentQueue(limit = 10): Promise<{ items: SfDocQueueItem[] }> {
  const supabase = db()
  const { data } = await supabase.from('sf_document_upload_queue').select('id, sf_job_id, sf_job_number, storage_path, filename, discovery')
    .eq('status', 'pending').lt('attempts', MAX_ATTEMPTS).order('created_at', { ascending: true }).limit(limit)
  const items: SfDocQueueItem[] = []
  for (const r of data ?? []) {
    let jobNumber = r.sf_job_number as string | null
    if (!jobNumber) {
      const { data: j } = await supabase.from('sf_jobs').select('number').eq('id', r.sf_job_id as string).maybeSingle()
      jobNumber = (j?.number as string | null) ?? null
    }
    const url = await signedUrl(r.storage_path as string, 3600)
    if (!url) continue
    items.push({ id: r.id as string, sfJobId: r.sf_job_id as string, jobNumber, filename: r.filename as string, downloadUrl: url, discovered: !!r.discovery })
  }
  return { items }
}

/** Extension callback for one item. `discovery` alone records what it found and leaves the
 *  item pending; ok/error record a real attempt. Idempotent on posted. */
export async function recordSfDocumentResult(id: string, result: { ok?: boolean; error?: string; discovery?: unknown; sfResponse?: unknown }): Promise<{ ok: boolean; error?: string }> {
  const supabase = db()
  const { data: row } = await supabase.from('sf_document_upload_queue').select('id, status, attempts, ref_table, ref_id').eq('id', id).maybeSingle()
  if (!row) return { ok: false, error: 'queue item not found' }
  if (row.status === 'posted') return { ok: true }
  const now = new Date().toISOString()
  if (result.discovery !== undefined && result.ok === undefined) {
    await supabase.from('sf_document_upload_queue').update({ discovery: result.discovery, discovered_at: now }).eq('id', id)
    return { ok: true }
  }
  const attempts = (row.attempts as number) + 1
  if (result.ok) {
    await supabase.from('sf_document_upload_queue').update({ status: 'posted', posted_at: now, attempts, sf_response: result.sfResponse ?? null, error: null }).eq('id', id)
    if (row.ref_table === 'esign_documents' && row.ref_id) {
      const { data: doc } = await supabase.from('esign_documents').select('id, order_id, status').eq('id', row.ref_id as string).maybeSingle()
      if (doc && doc.status === 'completed') {
        await supabase.from('esign_documents').update({ status: 'sf_uploaded', sf_uploaded_at: now, updated_at: now }).eq('id', doc.id)
        await supabase.from('vendor_order_events').insert({ order_id: doc.order_id, event_type: 'esign_sf_uploaded', to_value: 'posted', detail: { queue_id: id } })
      }
    }
  } else {
    await supabase.from('sf_document_upload_queue').update({ status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', attempts, error: result.error ?? 'unknown error', sf_response: result.sfResponse ?? null }).eq('id', id)
  }
  return { ok: true }
}

/** End-of-run report: uploads the extension could not do. One email listing them, each
 *  document at most once a day (esign_documents.sf_upload_alerted_at). */
export async function reportSfDocumentRunFailures(failures: Array<{ id: string; error?: string | null }>): Promise<{ ok: boolean; emailed: number }> {
  if (!failures.length) return { ok: true, emailed: 0 }
  const supabase = db()
  const ids = [...new Set(failures.map(f => f.id))]
  const { data: rows } = await supabase.from('sf_document_upload_queue').select('id, sf_job_number, filename, ref_table, ref_id').in('id', ids)
  const docIds = (rows ?? []).filter(r => r.ref_table === 'esign_documents' && r.ref_id).map(r => r.ref_id as string)
  const { data: docs } = docIds.length ? await supabase.from('esign_documents').select('id, sf_upload_alerted_at, prefill').in('id', docIds) : { data: [] }
  const since = Date.now() - 24 * 3600_000
  const fresh = (docs ?? []).filter(d => !d.sf_upload_alerted_at || new Date(d.sf_upload_alerted_at as string).getTime() < since)
  if (!fresh.length) return { ok: true, emailed: 0 }
  const errorFor = new Map(failures.map(f => [f.id, f.error ?? null]))
  const lines = fresh.map(d => {
    const q = (rows ?? []).find(r => r.ref_id === d.id)!
    const p = (d.prefill ?? {}) as Record<string, string>
    return `• ${p.customer_name ?? '—'} — job ${q.sf_job_number ?? '?'} — ${q.filename}${errorFor.get(q.id as string) ? ` — ${errorFor.get(q.id as string)}` : ''}`
  })
  const link = `${appUrl()}/admin/vendor-orders/signatures`
  const text = `The extension could not file these signed Home Depot forms on their Service Fusion jobs. Download each from the Signatures page and upload it to the job by hand:\n\n${lines.join('\n')}\n\n${link}`
  await enqueueForSubscribers({ notificationTypeKey: 'esign_office_alert', subject: `E-sign: ${fresh.length} signed form(s) need uploading to SF by hand`, bodyText: text, bodyHtml: `<pre style="font-family:system-ui;font-size:14px;white-space:pre-wrap">${text.replace(/</g, '&lt;').replace(link, `<a href="${link}">${link}</a>`)}</pre>`, relatedEntityType: 'sf_document_upload_queue', relatedEntityId: `failures:${new Date().toISOString()}` })
  await supabase.from('esign_documents').update({ sf_upload_alerted_at: new Date().toISOString() }).in('id', fresh.map(d => d.id as string))
  return { ok: true, emailed: fresh.length }
}
