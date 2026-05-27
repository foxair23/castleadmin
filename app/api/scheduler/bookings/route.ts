import { NextRequest, NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { syncLeadToServiceFusion } from '@/lib/scheduler/sf-sync'

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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Castle-Widget-Key',
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

interface BookingPayload {
  // Partial lead linkage
  partial_lead_id?: string
  session_id?: string
  // Contact (captured in step 2)
  first_name: string
  mobile_phone: string
  // Service
  primary_category: 'garage_door' | 'gate'
  service_type: string
  answers?: Record<string, string | undefined>
  // Optional details
  optional_note?: string
  uploaded_photo_urls?: string[]
  // Schedule
  appointment_date: string        // YYYY-MM-DD
  appointment_window_start: string // HH:MM
  appointment_window_end: string   // HH:MM
  // Property
  address_line1: string
  address_city: string
  address_state?: string
  address_zip: string
  address_is_owner?: boolean
  customer_email?: string
  additional_notes?: string
  // Widget
  widget_key?: string
}

function isValidDate(s: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s))
}

function isValidTime(s: string) {
  return /^\d{2}:\d{2}$/.test(s)
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin')
  const cors = corsHeaders(origin)

  // ── 1. Parse body ────────────────────────────────────────────────────────
  let body: BookingPayload
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors })
  }

  // ── 2. Widget key auth ───────────────────────────────────────────────────
  const key = req.headers.get('x-castle-widget-key') || body.widget_key
  if (!key) {
    return NextResponse.json({ error: 'Missing widget key' }, { status: 401, headers: cors })
  }

  const db = serviceClient()

  const { data: widget, error: widgetErr } = await db
    .from('scheduler_widget_instances')
    .select('id, lead_source, is_active')
    .eq('api_key', key)
    .single()

  if (widgetErr || !widget || !widget.is_active) {
    return NextResponse.json({ error: 'Invalid or inactive widget key' }, { status: 401, headers: cors })
  }

  // ── 2. Validate required fields ──────────────────────────────────────────
  const missing: string[] = []
  if (!body.first_name?.trim()) missing.push('first_name')
  if (!body.mobile_phone?.trim()) missing.push('mobile_phone')
  if (!body.primary_category) missing.push('primary_category')
  if (!body.service_type?.trim()) missing.push('service_type')
  if (!body.address_line1?.trim()) missing.push('address_line1')
  if (!body.address_city?.trim()) missing.push('address_city')
  if (!body.address_zip?.trim()) missing.push('address_zip')
  if (!body.appointment_date) missing.push('appointment_date')
  if (!body.appointment_window_start) missing.push('appointment_window_start')
  if (!body.appointment_window_end) missing.push('appointment_window_end')

  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Missing required fields: ${missing.join(', ')}` },
      { status: 400, headers: cors }
    )
  }

  if (!['garage_door', 'gate'].includes(body.primary_category)) {
    return NextResponse.json({ error: 'Invalid primary_category' }, { status: 400, headers: cors })
  }

  if (!isValidDate(body.appointment_date)) {
    return NextResponse.json({ error: 'Invalid appointment_date' }, { status: 400, headers: cors })
  }

  if (!isValidTime(body.appointment_window_start) || !isValidTime(body.appointment_window_end)) {
    return NextResponse.json({ error: 'Invalid appointment time window' }, { status: 400, headers: cors })
  }

  // ── 3. Capacity and min-notice validation ────────────────────────────────
  const { data: capSettings } = await db
    .from('scheduler_settings')
    .select('key, value')
    .in('key', ['min_notice_hours', 'max_jobs_per_day', 'max_bookings_per_window'])

  const cap: Record<string, unknown> = {}
  for (const r of capSettings ?? []) cap[r.key] = r.value

  const minNoticeHours = Number(cap.min_notice_hours ?? 24)
  const maxJobsPerDay  = Number(cap.max_jobs_per_day ?? 0)
  const maxPerWindow   = Number(cap.max_bookings_per_window ?? 0)

  // Min notice: window start on appointment_date must be ≥ minNoticeHours from now
  if (minNoticeHours > 0) {
    const [wHour, wMin] = body.appointment_window_start.split(':').map(Number)
    // Interpret appointment date + window start as America/Los_Angeles wall clock time
    const candidateUtc = new Date(`${body.appointment_date}T${body.appointment_window_start}:00`)
    const laMs = new Date(candidateUtc.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })).getTime()
    const offsetMs = candidateUtc.getTime() - laMs
    const windowStartUtc = new Date(candidateUtc.getTime() + offsetMs)
    void wHour; void wMin  // used implicitly via string parse above
    const hoursUntil = (windowStartUtc.getTime() - Date.now()) / 3_600_000
    if (hoursUntil < minNoticeHours) {
      return NextResponse.json(
        { error: `Appointments must be booked at least ${minNoticeHours} hour${minNoticeHours !== 1 ? 's' : ''} in advance.` },
        { status: 422, headers: cors }
      )
    }
  }

  // Daily SF job cap
  if (maxJobsPerDay > 0) {
    const CLOSED_STATUSES = ['Cancelled', 'Closed', 'Complete', 'Completed']
    const { count: sfCount } = await db
      .from('sf_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('start_date', body.appointment_date)
      .eq('is_deleted', false)
      .not('status', 'in', `(${CLOSED_STATUSES.map(s => `"${s}"`).join(',')})`)

    if ((sfCount ?? 0) >= maxJobsPerDay) {
      return NextResponse.json(
        { error: 'That date is fully booked. Please choose another date.' },
        { status: 422, headers: cors }
      )
    }
  }

  // Per-window booking cap
  if (maxPerWindow > 0) {
    const { count: windowCount } = await db
      .from('scheduler_leads')
      .select('id', { count: 'exact', head: true })
      .eq('appointment_date', body.appointment_date)
      .eq('appointment_window_start', body.appointment_window_start)
      .eq('is_partial', false)
      .neq('status', 'rejected')

    if ((windowCount ?? 0) >= maxPerWindow) {
      return NextResponse.json(
        { error: 'That time window is fully booked. Please choose another window.' },
        { status: 422, headers: cors }
      )
    }
  }

  // ── 4. Service area check ─────────────────────────────────────────────────
  const incomingCity = body.address_city.trim()
  const incomingZip  = body.address_zip.trim()

  const { data: cityMatch } = await db
    .from('scheduler_service_area_cities')
    .select('id')
    .eq('is_active', true)
    .ilike('city', incomingCity)
    .limit(1)

  let inServiceArea = !!(cityMatch && cityMatch.length > 0)

  if (!inServiceArea) {
    const { data: zipMatch } = await db
      .from('scheduler_city_zip_map')
      .select('city')
      .eq('zip', incomingZip)
      .limit(50)

    if (zipMatch && zipMatch.length > 0) {
      const zippedCities = zipMatch.map((r) => r.city)
      const { data: activeZipCity } = await db
        .from('scheduler_service_area_cities')
        .select('id')
        .eq('is_active', true)
        .in('city', zippedCities)
        .limit(1)
      inServiceArea = !!(activeZipCity && activeZipCity.length > 0)
    }
  }

  // ── 4. Duplicate check (same phone within 60 minutes, completed bookings only) ──
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()

  const { data: duplicate } = await db
    .from('scheduler_leads')
    .select('id')
    .eq('is_partial', false)
    .gte('created_at', oneHourAgo)
    .eq('customer_phone', body.mobile_phone.trim())
    .limit(1)

  if (duplicate && duplicate.length > 0) {
    return NextResponse.json(
      { error: 'A booking with this phone number was already submitted recently.' },
      { status: 429, headers: cors }
    )
  }

  // ── 5. Build lead row ─────────────────────────────────────────────────────
  const leadRow = {
    session_id:               body.session_id ?? null,
    is_partial:               false,
    lead_source:              widget.lead_source ?? 'website',
    widget_instance_id:       widget.id,
    // Service — map new field names to existing DB columns
    service_type:             body.primary_category,   // DB: 'garage_door'|'gate'
    service_category:         body.service_type,        // DB: 'repairs_service' etc.
    diagnostic_answers:       body.answers ?? {},
    // Customer
    customer_first_name:      body.first_name.trim(),
    customer_phone:           body.mobile_phone.trim(),
    customer_email:           body.customer_email?.trim().toLowerCase() || null,
    // Address
    address_line1:            body.address_line1.trim(),
    address_city:             incomingCity,
    address_state:            body.address_state?.trim() ?? 'CA',
    address_zip:              incomingZip,
    address_is_owner:         body.address_is_owner ?? true,
    address_in_service_area:  inServiceArea,
    // Appointment
    appointment_date:         body.appointment_date,
    appointment_window_start: body.appointment_window_start,
    appointment_window_end:   body.appointment_window_end,
    appointment_timezone:     'America/Los_Angeles',
    // Notes
    description:              body.optional_note?.trim() || null,
    additional_notes:         body.additional_notes?.trim() || null,
  }

  // ── 6. If partial_lead_id given, update that row; otherwise insert ────────
  let leadId: string | null = null
  let leadData: { id: string; appointment_date: string; appointment_window_start: string; appointment_window_end: string; address_in_service_area: boolean } | null = null

  if (body.partial_lead_id) {
    const { data, error } = await db
      .from('scheduler_leads')
      .update(leadRow)
      .eq('id', body.partial_lead_id)
      .select('id, appointment_date, appointment_window_start, appointment_window_end, address_in_service_area')
      .single()

    if (!error && data) {
      leadData = data as unknown as typeof leadData
      leadId = data.id
    }
  }

  // Fall back if no partial_lead_id or update failed.
  // First try to find an existing partial lead by session_id (avoids unique constraint conflict).
  if (!leadId && body.session_id) {
    const { data: existing } = await db
      .from('scheduler_leads')
      .select('id')
      .eq('session_id', body.session_id)
      .eq('is_partial', true)
      .maybeSingle()

    if (existing) {
      const { data, error } = await db
        .from('scheduler_leads')
        .update(leadRow)
        .eq('id', (existing as { id: string }).id)
        .select('id, appointment_date, appointment_window_start, appointment_window_end, address_in_service_area')
        .single()

      if (!error && data) {
        leadData = data as unknown as typeof leadData
        leadId = (data as { id: string }).id
      }
    }
  }

  // Final fallback: fresh insert
  if (!leadId) {
    const { data, error: insertErr } = await db
      .from('scheduler_leads')
      .insert({ ...leadRow, session_id: null })
      .select('id, appointment_date, appointment_window_start, appointment_window_end, address_in_service_area')
      .single()

    if (insertErr || !data) {
      console.error('[scheduler/bookings] insert error:', insertErr?.code, insertErr?.message, insertErr?.details)
      return NextResponse.json({ error: insertErr?.message ?? 'Failed to save booking' }, { status: 500, headers: cors })
    }

    leadData = data as unknown as typeof leadData
    leadId = (data as { id: string }).id
  }

  // ── 7. Auto-sync to Service Fusion if enabled ─────────────────────────────
  const { data: sfSetting } = await db
    .from('scheduler_settings')
    .select('value')
    .eq('key', 'auto_sync_to_sf')
    .maybeSingle()

  if (sfSetting?.value === true) {
    const syncLeadId = leadId!
    after(async () => {
      try {
        await syncLeadToServiceFusion(syncLeadId)
      } catch {
        // sync_status already set to sync_failed inside syncLeadToServiceFusion
      }
    })
  }

  return NextResponse.json(
    {
      id:                       leadData!.id,
      appointment_date:         leadData!.appointment_date,
      appointment_window_start: leadData!.appointment_window_start,
      appointment_window_end:   leadData!.appointment_window_end,
      in_service_area:          leadData!.address_in_service_area,
    },
    { status: 201, headers: cors }
  )
}
