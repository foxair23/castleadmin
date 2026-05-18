import { createClient } from '@/lib/supabase/server'
import WidgetsClient from './WidgetsClient'

export const dynamic = 'force-dynamic'

export default async function WidgetsPage() {
  const supabase = await createClient()

  const { data: widgets } = await supabase
    .from('scheduler_widget_instances')
    .select('id, display_name, lead_source, api_key, is_active, created_at')
    .order('created_at')

  return <WidgetsClient initialWidgets={widgets ?? []} />
}
