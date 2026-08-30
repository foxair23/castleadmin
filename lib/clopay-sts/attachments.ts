import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Storage for vendor-order attachments (the DC's acknowledgement PDF + any manual
// uploads). Private bucket, served to the browser via short-lived signed URLs.

const BUCKET = 'vendor-order-attachments'

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

const safeName = (n: string) => (n || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'file'

export interface AttachmentRow {
  id: string
  filename: string | null
  mime_type: string | null
  byte_size: number | null
  source: string
  created_at: string
  storage_path: string
}

/** Upload bytes to storage + record the row. Returns the new attachment id. */
export async function uploadAttachmentBytes(
  orderId: string, filename: string, mime: string, bytes: Uint8Array, source: string, userId: string | null,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const supabase = db()
  const path = `${orderId}/${crypto.randomUUID()}-${safeName(filename)}`
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, bytes, {
    contentType: mime || 'application/octet-stream', upsert: false,
  })
  if (upErr) return { ok: false, error: upErr.message }
  const { data, error } = await supabase.from('vendor_order_attachments').insert({
    order_id: orderId, storage_path: path, filename: safeName(filename),
    mime_type: mime || null, byte_size: bytes.byteLength, source, created_by: userId,
  }).select('id').single()
  if (error) return { ok: false, error: error.message }
  return { ok: true, id: data.id as string }
}

export async function listAttachments(orderId: string): Promise<AttachmentRow[]> {
  const { data } = await db()
    .from('vendor_order_attachments')
    .select('id, filename, mime_type, byte_size, source, created_at, storage_path')
    .eq('order_id', orderId)
    .order('created_at', { ascending: true })
  return (data ?? []) as AttachmentRow[]
}

export async function signedUrl(storagePath: string, expiresIn = 3600): Promise<string | null> {
  const { data } = await db().storage.from(BUCKET).createSignedUrl(storagePath, expiresIn)
  return data?.signedUrl ?? null
}

/** Batch-mint signed URLs (path → url) in ONE Storage round-trip — the per-attachment
 *  loop this replaces cost a client + an HTTPS call per file. */
export async function signedUrlsForPaths(paths: string[], expiresIn = 3600): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (!paths.length) return map
  const { data } = await db().storage.from(BUCKET).createSignedUrls(paths, expiresIn)
  for (const d of (data ?? [])) if (d.path && d.signedUrl) map.set(d.path, d.signedUrl)
  return map
}
