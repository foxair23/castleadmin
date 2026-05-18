import { createClient } from '@/lib/supabase/server'
import SettingsClient from './SettingsClient'

export const dynamic = 'force-dynamic'

export default async function SchedulerSettingsPage() {
  const supabase = await createClient()

  const { data: rows } = await supabase
    .from('scheduler_settings')
    .select('key, value')

  const settings: Record<string, unknown> = {}
  for (const row of rows ?? []) {
    settings[row.key] = row.value
  }

  return <SettingsClient initialSettings={settings} />
}
