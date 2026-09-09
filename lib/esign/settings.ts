import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// The e-sign switch, per vendor + document type (mirrors vendor_schedule_nudge). OFF by
// default. Turning it ON stamps enabled_at, and only documents FOUND after that moment are
// ever sent automatically — the ~200 blanks already on file stay quiet unless someone sends
// one by hand from the Signatures page.

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export interface EsignSettings { enabled: boolean; enabledAt: string | null }

export async function getEsignSettings(vendor = 'clopay_hd', docType = 'lien_waiver'): Promise<EsignSettings> {
  const { data } = await db().from('esign_settings').select('enabled, enabled_at').eq('vendor', vendor).eq('doc_type', docType).maybeSingle()
  return { enabled: !!data?.enabled, enabledAt: data?.enabled_at ?? null }
}

export async function setEsignSettings(vendor: string, docType: string, enabled: boolean, userId: string | null): Promise<void> {
  const patch: Record<string, unknown> = { vendor, doc_type: docType, enabled, updated_at: new Date().toISOString(), updated_by: userId }
  if (enabled) patch.enabled_at = new Date().toISOString()   // fresh cutoff every time it goes ON
  await db().from('esign_settings').upsert(patch, { onConflict: 'vendor,doc_type' })
}
