import type { SupabaseClient } from '@supabase/supabase-js'

// Customer-uploaded scheduler photos live in the private 'scheduler-uploads'
// bucket, keyed by lead. These helpers produce signed URLs for every surface
// that shows them (SF job description, notification emails, Action Items tab).

const BUCKET = 'scheduler-uploads'

export interface LeadPhoto {
  filename: string
  url: string
}

/** Signed photo URLs for one lead, oldest first. */
export async function getLeadPhotoUrls(
  db: SupabaseClient,
  leadId: string,
  ttlSeconds: number
): Promise<LeadPhoto[]> {
  const { data: atts } = await db
    .from('scheduler_lead_attachments')
    .select('filename, storage_path')
    .eq('lead_id', leadId)
    .order('uploaded_at', { ascending: true })
  const rows = (atts ?? []) as { filename: string; storage_path: string }[]
  if (rows.length === 0) return []

  const { data: signed } = await db.storage
    .from(BUCKET)
    .createSignedUrls(rows.map(r => r.storage_path), ttlSeconds)
  const byPath = new Map((signed ?? []).map(s => [s.path, s.signedUrl]))

  return rows.flatMap(r => {
    const url = byPath.get(r.storage_path)
    return url ? [{ filename: r.filename, url }] : []
  })
}

/** Signed photo URLs for many leads in two round trips: leadId → urls. */
export async function getPhotoUrlsForLeads(
  db: SupabaseClient,
  leadIds: string[],
  ttlSeconds: number
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (leadIds.length === 0) return out

  const { data: atts } = await db
    .from('scheduler_lead_attachments')
    .select('lead_id, storage_path')
    .in('lead_id', leadIds)
    .order('uploaded_at', { ascending: true })
  const rows = (atts ?? []) as { lead_id: string; storage_path: string }[]
  if (rows.length === 0) return out

  const { data: signed } = await db.storage
    .from(BUCKET)
    .createSignedUrls(rows.map(r => r.storage_path), ttlSeconds)
  const byPath = new Map((signed ?? []).map(s => [s.path, s.signedUrl]))

  for (const r of rows) {
    const url = byPath.get(r.storage_path)
    if (!url) continue
    const list = out.get(r.lead_id) ?? []
    list.push(url)
    out.set(r.lead_id, list)
  }
  return out
}
