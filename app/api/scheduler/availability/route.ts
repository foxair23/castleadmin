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
    'Cache-Control': 'no-store',
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

interface TimeWindow {
  start: string  // 'HH:MM'
  end: string
  label: string
}

interface WindowAvailability extends TimeWindow {
  available: boolean
  reason?: 'full' | 'too_soon'
}

interface DateAvailability {
  available: boolean   // false = whole day blocked (all windows unavailable)
  windows: WindowAvailability[]
}

// Convert 'HH:MM' + YYYY-MM-DD to a Date in America/Los_Angeles
function windowStartDate(date: string, time: string): Date {
  // Build an ISO string as if it were LA local time, then correct via Intl
  // Simple approach: use a fixed LA offset based on whether DST is active.
  // We create a Date from the YYYY-MM-DDTHH:MM string in UTC then adjust.
  // More correctly: parse the time and date and treat as LA wall clock time.
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  // Use Intl.DateTimeFormat to find the UTC offset for LA at this moment
  const candidate = new Date(Date.UTC(year, month - 1, day, hour, minute))
  // Determine the LA offset at this candidate UTC time
  const laStr = candidate.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  // laStr: "MM/DD/YYYY, HH:MM" or similar — use a simpler method:
  // Find difference between UTC and LA at this point
  const utcMs = candidate.getTime()
  const laDate = new Date(candidate.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }))
  const offset = utcMs - laDate.getTime()
  return new Date(utcMs + offset)
}

export async function GET(req: NextRequest) {
  const origin = req.headers.get('origin')
  const cors = corsHeaders(origin)

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

  const { searchParams } = new URL(req.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')

  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return NextResponse.json({ error: 'from and to (YYYY-MM-DD) are required' }, { status: 400, headers: cors })
  }

  // Load relevant settings in one query
  const { data: settingRows } = await db
    .from('scheduler_settings')
    .select('key, value')
    .in('key', ['time_windows', 'min_notice_hours', 'max_jobs_per_day', 'max_bookings_per_window'])

  const settings: Record<string, unknown> = {}
  for (const r of settingRows ?? []) settings[r.key] = r.value

  const timeWindows: TimeWindow[] = Array.isArray(settings.time_windows)
    ? (settings.time_windows as TimeWindow[])
    : [
        { start: '08:00', end: '12:00', label: '8 AM – 12 PM' },
        { start: '12:00', end: '16:00', label: '12 PM – 4 PM' },
      ]

  const minNoticeHours = typeof settings.min_notice_hours === 'number'
    ? settings.min_notice_hours
    : Number(settings.min_notice_hours ?? 24)

  const maxJobsPerDay = typeof settings.max_jobs_per_day === 'number'
    ? settings.max_jobs_per_day
    : Number(settings.max_jobs_per_day ?? 0)

  const maxBookingsPerWindow = typeof settings.max_bookings_per_window === 'number'
    ? settings.max_bookings_per_window
    : Number(settings.max_bookings_per_window ?? 0)

  const nowMs = Date.now()

  // Count SF jobs per day (and per window) in range (open/dispatched, not cancelled or deleted)
  const CLOSED_STATUSES = ['Cancelled', 'Closed', 'Complete', 'Completed']
  const { data: sfJobs } = await db
    .from('sf_jobs')
    .select('start_date, time_frame_promised_start')
    .gte('start_date', from)
    .lte('start_date', to)
    .eq('is_deleted', false)
    .not('start_date', 'is', null)
    .not('status', 'in', `(${CLOSED_STATUSES.map(s => `"${s}"`).join(',')})`)

  const sfCountByDate = new Map<string, number>()
  // key: "YYYY-MM-DD|windowStart" — keyed by the window the SF job falls within
  const sfCountByDateWindow = new Map<string, number>()
  for (const j of sfJobs ?? []) {
    const d = j.start_date as string
    sfCountByDate.set(d, (sfCountByDate.get(d) ?? 0) + 1)
    const tfps = j.time_frame_promised_start as string | null
    if (tfps) {
      // Find which scheduler window this SF job's start time falls within
      const matchingWindow = timeWindows.find(w => tfps >= w.start && tfps < w.end)
      if (matchingWindow) {
        const key = `${d}|${matchingWindow.start}`
        sfCountByDateWindow.set(key, (sfCountByDateWindow.get(key) ?? 0) + 1)
      }
    }
  }

  // Count approved/pending scheduler_leads per date+window in range
  const { data: leads } = await db
    .from('scheduler_leads')
    .select('appointment_date, appointment_window_start')
    .gte('appointment_date', from)
    .lte('appointment_date', to)
    .eq('is_partial', false)
    .neq('status', 'rejected')

  // key: "YYYY-MM-DD|HH:MM"
  const leadCountByDateWindow = new Map<string, number>()
  for (const l of leads ?? []) {
    const key = `${l.appointment_date}|${l.appointment_window_start}`
    leadCountByDateWindow.set(key, (leadCountByDateWindow.get(key) ?? 0) + 1)
  }

  // Build date list between from and to inclusive
  const result: Record<string, DateAvailability> = {}
  const cursor = new Date(from + 'T00:00:00Z')
  const end = new Date(to + 'T00:00:00Z')

  while (cursor <= end) {
    const dateStr = cursor.toISOString().slice(0, 10)

    const sfCount = sfCountByDate.get(dateStr) ?? 0
    const dayFull = maxJobsPerDay > 0 && sfCount >= maxJobsPerDay

    const windows: WindowAvailability[] = timeWindows.map((w) => {
      if (dayFull) return { ...w, available: false, reason: 'full' as const }

      // Min notice check: window start time on this date must be ≥ minNoticeHours from now
      const windowStart = windowStartDate(dateStr, w.start)
      const hoursUntil = (windowStart.getTime() - nowMs) / 3_600_000
      if (hoursUntil < minNoticeHours) return { ...w, available: false, reason: 'too_soon' as const }

      // Per-window booking cap: scheduler leads + SF jobs in this window
      if (maxBookingsPerWindow > 0) {
        const key = `${dateStr}|${w.start}`
        const schedulerCount = leadCountByDateWindow.get(key) ?? 0
        const sfWindowCount = sfCountByDateWindow.get(key) ?? 0
        if (schedulerCount + sfWindowCount >= maxBookingsPerWindow) return { ...w, available: false, reason: 'full' as const }
      }

      return { ...w, available: true }
    })

    result[dateStr] = {
      available: windows.some((w) => w.available),
      windows,
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  return NextResponse.json({ dates: result }, { status: 200, headers: cors })
}
