import { createClient } from '@/lib/supabase/server'
import WidgetsClient from './WidgetsClient'

export const dynamic = 'force-dynamic'

export default async function WidgetsPage() {
  const supabase = await createClient()

  const { data: widgets } = await supabase
    .from('scheduler_widget_instances')
    .select('id, display_name, lead_source, sf_job_source, api_key, is_active, created_at')
    .order('created_at')

  // Existing Service Fusion Job Sources, for the picker. short_name is the value
  // SF matches on when creating a job.
  const { data: sourceRows } = await supabase
    .from('sf_sources')
    .select('short_name')
    .eq('is_deleted', false)
    .not('short_name', 'is', null)
    .order('short_name')
  const sources = [...new Set(
    (sourceRows ?? []).map(r => (r.short_name as string)).filter(Boolean)
  )]
  if (!sources.includes('Website')) sources.unshift('Website')

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://castleadmin.vercel.app'

  return <WidgetsClient initialWidgets={widgets ?? []} sfSources={sources} appUrl={appUrl} />
}
