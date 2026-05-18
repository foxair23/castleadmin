import { createClient } from '@/lib/supabase/server'
import PreviewClient from './PreviewClient'

export const dynamic = 'force-dynamic'

export default async function SchedulerPreviewPage() {
  const supabase = await createClient()

  const { data: widgets } = await supabase
    .from('scheduler_widget_instances')
    .select('id, display_name, api_key, is_active')
    .order('created_at')

  return <PreviewClient widgets={widgets ?? []} />
}
