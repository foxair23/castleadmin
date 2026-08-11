import { createClient } from '@supabase/supabase-js'
import { unstable_cache } from 'next/cache'
import GenieScheduler, { GenieConfig } from './GenieScheduler'

export const dynamic = 'force-dynamic'

function serviceClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

const getCachedWidget = unstable_cache(
  async (key: string) => {
    const { data } = await serviceClient().from('scheduler_widget_instances').select('id, is_active, lead_source').eq('api_key', key).single()
    return data
  },
  ['genie-embed-widget'],
  { revalidate: 60 },
)

const CONFIG_KEYS = ['office_phone', 'time_windows', 'available_days', 'scheduling_horizon_days', 'scheduling_enabled', 'scheduling_disabled_message', 'genie_min_lead_days']

const getCachedSettings = unstable_cache(
  async () => {
    const { data } = await serviceClient().from('scheduler_settings').select('key, value').in('key', CONFIG_KEYS)
    return data ?? []
  },
  ['genie-embed-settings'],
  { revalidate: 60 },
)

const DEFAULTS: GenieConfig = {
  office_phone: '(800) 576-1397',
  time_windows: [
    { start: '08:00', end: '12:00', label: '8 AM – 12 PM' },
    { start: '12:00', end: '16:00', label: '12 PM – 4 PM' },
  ],
  available_days: [1, 2, 3, 4, 5, 6],
  scheduling_horizon_days: 14,
  scheduling_enabled: true,
  scheduling_disabled_message: 'Online scheduling is temporarily unavailable. Please call us to book.',
  min_lead_days: 7,
}

const invalid = (
  <div style={{ padding: '2rem', textAlign: 'center', color: '#6B6B6B', fontFamily: 'sans-serif' }}>Invalid scheduling link.</div>
)

export default async function GenieSchedulerPage({ searchParams }: { searchParams: Promise<{ key?: string }> }) {
  const { key } = await searchParams
  if (!key) return invalid

  const [widget, rows] = await Promise.all([getCachedWidget(key), getCachedSettings()])
  if (!widget || !widget.is_active) return invalid

  const settingsMap: Record<string, unknown> = {}
  for (const row of rows) settingsMap[row.key] = row.value

  const config: GenieConfig = {
    office_phone: (settingsMap.office_phone as string) ?? DEFAULTS.office_phone,
    time_windows: (settingsMap.time_windows as GenieConfig['time_windows']) ?? DEFAULTS.time_windows,
    available_days: (settingsMap.available_days as number[]) ?? DEFAULTS.available_days,
    scheduling_horizon_days: (settingsMap.scheduling_horizon_days as number) ?? DEFAULTS.scheduling_horizon_days,
    scheduling_enabled: (settingsMap.scheduling_enabled as boolean) ?? DEFAULTS.scheduling_enabled,
    scheduling_disabled_message: (settingsMap.scheduling_disabled_message as string) ?? DEFAULTS.scheduling_disabled_message,
    min_lead_days: (settingsMap.genie_min_lead_days as number) ?? DEFAULTS.min_lead_days,
  }

  return <GenieScheduler config={config} widgetKey={key} />
}
