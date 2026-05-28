import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const ALLOWED_ORIGINS = [
  'https://schedule.castlegaragedoors.com',
  'https://foxair23.github.io',
  /^http:\/\/localhost:\d+$/,
]

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed =
    origin &&
    ALLOWED_ORIGINS.some((o) =>
      typeof o === 'string' ? o === origin : o.test(origin)
    )
  return {
    'Access-Control-Allow-Origin': allowed ? origin! : 'null',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Castle-Widget-Key',
    'Cache-Control': 'public, max-age=60',
  }
}

export async function OPTIONS(req: NextRequest) {
  const origin = req.headers.get('origin')
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) })
}

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

// Public keys that the scheduler widget is allowed to read.
// Do NOT expose keys like sync_mode or internal operational settings.
const PUBLIC_KEYS = [
  'office_phone',
  'tcpa_copy',
  'marketing_sms_copy',
  'time_windows',
  'available_days',
  'scheduling_horizon_days',
  'scheduling_enabled',
  'scheduling_disabled_message',
  'garage_door_categories',
  'gate_categories',
  'garage_door_issues',
  'gate_issues',
  'incentive_banner_enabled',
  'incentive_banner_text',
  'service_call_fee',
]

export async function GET(req: NextRequest) {
  const origin = req.headers.get('origin')
  const cors = corsHeaders(origin)

  // Widget key auth — required so unknown callers can't enumerate config
  const widgetKey = req.headers.get('x-castle-widget-key')
  if (!widgetKey) {
    return NextResponse.json({ error: 'Missing widget key' }, { status: 401, headers: cors })
  }

  const db = serviceClient()

  const { data: widget } = await db
    .from('scheduler_widget_instances')
    .select('id, is_active')
    .eq('api_key', widgetKey)
    .single()

  if (!widget || !widget.is_active) {
    return NextResponse.json({ error: 'Invalid or inactive widget key' }, { status: 401, headers: cors })
  }

  const { data: rows, error } = await db
    .from('scheduler_settings')
    .select('key, value')
    .in('key', PUBLIC_KEYS)

  if (error) {
    console.error('[scheduler/config] fetch error:', error)
    return NextResponse.json({ error: 'Failed to load config' }, { status: 500, headers: cors })
  }

  const config: Record<string, unknown> = {}
  for (const row of rows ?? []) {
    config[row.key] = row.value
  }

  return NextResponse.json({ config }, { status: 200, headers: cors })
}
