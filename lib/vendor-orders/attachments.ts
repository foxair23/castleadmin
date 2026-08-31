import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Storing vendor-order document FILES (Clopay HD-Program docs downloaded by the
// crawler) in the private `vendor-order-attachments` bucket. The extension can't
// POST large binaries through the JSON ingest route (Vercel's 4.5MB body cap), so
// it uses the scheduler's signed-direct-upload pattern: we mint a signed upload URL,
// the extension PUTs the bytes straight to Supabase Storage, then calls `complete`
// to record the row. Dedup is keyed by Clopay's document id (external_ref) so a
// re-crawl never re-downloads a file we already have.

const BUCKET = 'vendor-order-attachments'

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}
const safeName = (n: string) => (n || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'file'

async function orderIdFor(vendor: string, externalId: string): Promise<string | null> {
  const { data } = await db().from('vendor_orders').select('id').eq('vendor', vendor).eq('external_id', externalId).maybeSingle()
  return (data?.id as string) ?? null
}

/** Mint a signed upload URL for a Clopay document, deduped by (order, documentId).
 *  Returns { alreadyStored:true } when we already have it (extension skips the
 *  download), else { uploadUrl, path } for the extension to PUT the bytes to. */
export async function signVendorAttachmentUpload(
  vendor: string, externalId: string, documentId: string, filename: string,
): Promise<{ ok: boolean; alreadyStored?: boolean; uploadUrl?: string; path?: string; error?: string }> {
  const orderId = await orderIdFor(vendor, externalId)
  if (!orderId) return { ok: false, error: 'order not found' }
  const ref = String(documentId)
  const { data: existing } = await db().from('vendor_order_attachments')
    .select('id').eq('order_id', orderId).eq('external_ref', ref).maybeSingle()
  if (existing) return { ok: true, alreadyStored: true }
  const path = `${orderId}/${ref}-${safeName(filename)}`
  const { data, error } = await db().storage.from(BUCKET).createSignedUploadUrl(path)
  if (error) return { ok: false, error: error.message }
  return { ok: true, uploadUrl: data.signedUrl, path }
}

/** Record a completed upload (after the extension PUT the bytes). Idempotent via the
 *  (order_id, external_ref) unique index. */
export async function recordVendorAttachment(
  vendor: string, externalId: string, documentId: string, path: string, filename: string, mime: string, size: number,
): Promise<{ ok: boolean; error?: string }> {
  const orderId = await orderIdFor(vendor, externalId)
  if (!orderId) return { ok: false, error: 'order not found' }
  if (!path.startsWith(`${orderId}/`)) return { ok: false, error: 'path mismatch' }
  const { error } = await db().from('vendor_order_attachments').insert({
    order_id: orderId, storage_path: path, filename: safeName(filename),
    mime_type: mime || null, byte_size: size ?? null, source: 'clopay_doc', external_ref: String(documentId),
  })
  if (error && !/duplicate key|unique/i.test(error.message)) return { ok: false, error: error.message }
  return { ok: true }
}

/** Check-or-store one Clopay document. With no bytes it's a dedup check (returns
 *  {alreadyStored} or {needsUpload}); with bytes it uploads (UPSERT — overwrites any
 *  earlier bad copy) and records the row. Keyed/deduped by (order, documentId). */
export async function storeVendorDoc(
  vendor: string, externalId: string, documentId: string, filename: string, mime: string, bytes: Uint8Array | null,
): Promise<{ ok: boolean; alreadyStored?: boolean; needsUpload?: boolean; stored?: boolean; error?: string }> {
  const orderId = await orderIdFor(vendor, externalId)
  if (!orderId) return { ok: false, error: 'order not found' }
  const ref = String(documentId)
  const { data: existing } = await db().from('vendor_order_attachments')
    .select('id').eq('order_id', orderId).eq('external_ref', ref).maybeSingle()
  if (existing) return { ok: true, alreadyStored: true }
  if (!bytes) return { ok: true, needsUpload: true }
  const path = `${orderId}/${ref}-${safeName(filename)}`
  const { error: upErr } = await db().storage.from(BUCKET).upload(path, bytes, {
    contentType: mime || 'application/pdf', upsert: true,
  })
  if (upErr) return { ok: false, error: upErr.message }
  const { error } = await db().from('vendor_order_attachments').insert({
    order_id: orderId, storage_path: path, filename: safeName(filename),
    mime_type: mime || 'application/pdf', byte_size: bytes.byteLength, source: 'clopay_doc', external_ref: ref,
  })
  if (error && !/duplicate key|unique/i.test(error.message)) return { ok: false, error: error.message }
  return { ok: true, stored: true }
}

export interface StoredAttachment {
  id: string
  order_id: string
  filename: string | null
  mime_type: string | null
  byte_size: number | null
  source: string
  created_at: string
  storage_path: string
  external_ref: string | null
}

/** All stored attachments for a set of order ids, grouped by order_id (for the tab). */
export async function attachmentsForOrders(orderIds: string[]): Promise<Map<string, StoredAttachment[]>> {
  const map = new Map<string, StoredAttachment[]>()
  if (!orderIds.length) return map
  const { data } = await db().from('vendor_order_attachments')
    .select('id, order_id, filename, mime_type, byte_size, source, created_at, storage_path, external_ref')
    .in('order_id', orderIds)
    .order('created_at', { ascending: true })
  for (const r of (data ?? []) as StoredAttachment[]) {
    const arr = map.get(r.order_id) || []
    arr.push(r)
    map.set(r.order_id, arr)
  }
  return map
}

/** Look up a stored attachment's id by (vendor, external_id, documentId) — lets the store
 *  route hand the freshly-stored document straight to the IPO parser. */
export async function findAttachmentId(vendor: string, externalId: string, documentId: string): Promise<string | null> {
  const orderId = await orderIdFor(vendor, externalId)
  if (!orderId) return null
  const { data } = await db().from('vendor_order_attachments')
    .select('id').eq('order_id', orderId).eq('external_ref', String(documentId)).maybeSingle()
  return (data?.id as string) ?? null
}

/** Read a stored document's bytes back out of the bucket (server-side). Used by the IPO
 *  parser — nothing else needed to download until now. */
export async function downloadVendorDoc(storagePath: string): Promise<Uint8Array | null> {
  const { data, error } = await db().storage.from(BUCKET).download(storagePath)
  if (error || !data) return null
  return new Uint8Array(await data.arrayBuffer())
}

export async function signedUrl(storagePath: string, expiresIn = 3600): Promise<string | null> {
  const { data } = await db().storage.from(BUCKET).createSignedUrl(storagePath, expiresIn)
  return data?.signedUrl ?? null
}

/** Batch-mint signed URLs for many paths in one call (path → url). */
export async function signedUrls(paths: string[], expiresIn = 3600): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (!paths.length) return map
  const { data } = await db().storage.from(BUCKET).createSignedUrls(paths, expiresIn)
  for (const d of (data ?? [])) if (d.path && d.signedUrl) map.set(d.path, d.signedUrl)
  return map
}
