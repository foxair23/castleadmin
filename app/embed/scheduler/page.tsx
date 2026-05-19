import { createClient } from '@supabase/supabase-js'
import { SchedulerConfig } from './lib/types'
import { DEFAULT_CONFIG } from './lib/api'
import SchedulerEmbed from './SchedulerEmbed'

export const dynamic = 'force-dynamic'

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

const CONFIG_KEYS = [
  'office_phone',
  'tcpa_copy',
  'marketing_sms_copy',
  'time_windows',
  'available_days',
  'scheduling_horizon_days',
  'scheduling_enabled',
  'scheduling_disabled_message',
  'incentive_banner_enabled',
  'incentive_banner_text',
]

interface SearchParams {
  key?: string
}

export default async function SchedulerPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const { key } = await searchParams

  if (!key) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center', color: '#6B6B6B', fontFamily: 'sans-serif' }}>
        Invalid booking link.
      </div>
    )
  }

  const db = serviceClient()

  const { data: widget } = await db
    .from('scheduler_widget_instances')
    .select('id, is_active')
    .eq('api_key', key)
    .single()

  if (!widget || !widget.is_active) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center', color: '#6B6B6B', fontFamily: 'sans-serif' }}>
        Invalid booking link.
      </div>
    )
  }

  const { data: rows } = await db
    .from('scheduler_settings')
    .select('key, value')
    .in('key', CONFIG_KEYS)

  const settingsMap: Record<string, unknown> = {}
  for (const row of rows ?? []) {
    settingsMap[row.key] = row.value
  }

  const config: SchedulerConfig = {
    office_phone: (settingsMap.office_phone as string) ?? DEFAULT_CONFIG.office_phone,
    time_windows: (settingsMap.time_windows as SchedulerConfig['time_windows']) ?? DEFAULT_CONFIG.time_windows,
    scheduling_horizon_days: (settingsMap.scheduling_horizon_days as number) ?? DEFAULT_CONFIG.scheduling_horizon_days,
    available_days: (settingsMap.available_days as number[]) ?? DEFAULT_CONFIG.available_days,
    incentive_banner_enabled: (settingsMap.incentive_banner_enabled as boolean) ?? DEFAULT_CONFIG.incentive_banner_enabled,
    incentive_banner_text: (settingsMap.incentive_banner_text as string) ?? DEFAULT_CONFIG.incentive_banner_text,
    tcpa_copy: (settingsMap.tcpa_copy as string) ?? DEFAULT_CONFIG.tcpa_copy,
    marketing_sms_copy: (settingsMap.marketing_sms_copy as string) ?? DEFAULT_CONFIG.marketing_sms_copy,
    scheduling_enabled: (settingsMap.scheduling_enabled as boolean) ?? DEFAULT_CONFIG.scheduling_enabled,
    scheduling_disabled_message: (settingsMap.scheduling_disabled_message as string) ?? DEFAULT_CONFIG.scheduling_disabled_message,
  }

  return <SchedulerEmbed config={config} widgetKey={key} />
}
