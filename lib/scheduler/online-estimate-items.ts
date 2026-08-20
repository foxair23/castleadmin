import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getPhotoUrlsForLeads } from '@/lib/scheduler/photos'

// Action Items "Online Estimates" tab: one row per open Free Online Estimate
// request (a scheduler lead with estimate_channel='online' not yet acknowledged).
// The office reviews the photos, prices the SF estimate, emails the customer,
// then presses Done (which stamps acknowledged_at via /api/leads/ack).

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export interface OnlineEstimateItem {
  id: string
  customer_name: string
  phone: string | null
  email: string | null
  service_category: string | null   // door_panel_replacement | opener_service
  opener_need: string | null
  created_at: string
  days_waiting: number
  sf_estimate_number: string | null
  sync_status: string | null        // 'synced' ⇒ in SF; 'sync_failed' ⇒ review-only
  photos: string[]
}
export interface OnlineEstimateItemsResult { items: OnlineEstimateItem[] }

export async function getOnlineEstimateItems(): Promise<OnlineEstimateItemsResult> {
  const supabase = db()
  const { data } = await supabase
    .from('scheduler_leads')
    .select('id, customer_first_name, customer_last_name, customer_phone, customer_email, service_category, diagnostic_answers, created_at, service_fusion_estimate_number, sync_status')
    .eq('estimate_channel', 'online')
    .is('acknowledged_at', null)
    .order('created_at', { ascending: false })
    .limit(500)

  const rows = (data ?? []) as Array<Record<string, unknown>>
  const ids = rows.map(r => r.id as string)
  const photoMap = await getPhotoUrlsForLeads(supabase, ids, 60 * 60 * 24 * 7).catch(() => new Map<string, string[]>())

  // eslint-disable-next-line react-hooks/purity -- server render; wall-clock age is intentional
  const now = Date.now()
  const items: OnlineEstimateItem[] = rows.map(r => {
    const diag = (r.diagnostic_answers as Record<string, string> | null) ?? {}
    const created = r.created_at as string
    return {
      id: r.id as string,
      customer_name: [r.customer_first_name, r.customer_last_name].filter(Boolean).join(' ') || '—',
      phone: (r.customer_phone as string) ?? null,
      email: (r.customer_email as string) ?? null,
      service_category: (r.service_category as string) ?? null,
      opener_need: diag.opener_need ?? null,
      created_at: created,
      days_waiting: created ? Math.floor((now - new Date(created).getTime()) / 86400000) : 0,
      sf_estimate_number: (r.service_fusion_estimate_number as string) ?? null,
      sync_status: (r.sync_status as string) ?? null,
      photos: photoMap.get(r.id as string) ?? [],
    }
  })
  return { items }
}
