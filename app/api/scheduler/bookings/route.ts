import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const ALLOWED_ORIGINS = [
  'https://schedule.castlegaragedoors.com',
  'https://foxair23.github.io',
  // Allow localhost for development
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
  service_type: 'garage_door' | 'gate'
  service_category: string
  diagnostic_answers?: Record<string, unknown>
  customer_first_name: string
  customer_last_name: string
  customer_phone: string
  customer_email: string
  customer_sms_appointment_consent?: boolean
  customer_sms_marketing_consent?: boolean
  address_line1: string
  address_line2?: string
  address_city: string
  address_state?: string
  address_zip: string
  address_is_owner?: boolean
  appointment_date: string        // YYYY-MM-DD
  appointment_window_start: string // HH:MM
  appointment_window_end: string   // HH:MM
  description?: string
  incentive_applied?: string
}

const REQUIRED_FIELDS: (keyof BookingPayload)[] = [
  'service_type',
  'service_category',
  'customer_first_name',
  'customer_last_name',
  'customer_phone',
  'customer_email',
  'address_line1',
  'address_city',
  'address_zip',
  'appointment_date',
  'appointment_window_start',
  'appointment_window_end',
]

function isValidDate(s: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s))
}

function isValidTime(s: string) {
  return /^\d{2}:\d{2}$/.test(s)
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin')
  const cors = corsHeaders(origin)

  // ── 1. Widget key auth ───────────────────────────────────────────────────
  const widgetKey = req.headers.get('x-castle-widget-key')
  if (!widgetKey) {
    return NextResponse.json({ error: 'Missing widget key' }, { status: 401, headers: cors })
  }

  const db = serviceClient()

  const { data: widget, error: widgetErr } = await db
    .from('scheduler_widget_instances')
    .select('id, lead_source, is_active')
    .eq('api_key', widgetKey)
    .single()

  if (widgetErr || !widget || !widget.is_active) {
    return NextResponse.json({ error: 'Invalid or inactive widget key' }, { status: 401, headers: cors })
  }

  // ── 2. Parse + validate payload ──────────────────────────────────────────
  let body: BookingPayload
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors })
  }

  const missing = REQUIRED_FIELDS.filter((f) => {
    const v = body[f]
    return v === undefined || v === null || v === ''
  })
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Missing required fields: ${missing.join(', ')}` },
      { status: 400, headers: cors }
    )
  }

  if (!['garage_door', 'gate'].includes(body.service_type)) {
    return NextResponse.json({ error: 'Invalid service_type' }, { status: 400, headers: cors })
  }

  if (!isValidDate(body.appointment_date)) {
    return NextResponse.json({ error: 'Invalid appointment_date' }, { status: 400, headers: cors })
  }

  if (!isValidTime(body.appointment_window_start) || !isValidTime(body.appointment_window_end)) {
    return NextResponse.json({ error: 'Invalid appointment time window' }, { status: 400, headers: cors })
  }

  // ── 3. Service area check ─────────────────────────────────────────────────
  // City match (case-insensitive) against active service area cities
  const incomingCity = body.address_city.trim()
  const incomingZip  = body.address_zip.trim()

  const { data: cityMatch } = await db
    .from('scheduler_service_area_cities')
    .select('id')
    .eq('is_active', true)
    .ilike('city', incomingCity)
    .limit(1)

  let inServiceArea = !!(cityMatch && cityMatch.length > 0)

  // Zip match against city→zip map where city is active
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

  // ── 4. Duplicate check (same phone or email within 60 minutes) ────────────
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()

  const { data: duplicate } = await db
    .from('scheduler_leads')
    .select('id')
    .gte('created_at', oneHourAgo)
    .or(
      `customer_phone.eq.${body.customer_phone},customer_email.eq.${body.customer_email}`
    )
    .limit(1)

  if (duplicate && duplicate.length > 0) {
    return NextResponse.json(
      { error: 'A booking with this contact information was already submitted recently. Please wait before trying again.' },
      { status: 429, headers: cors }
    )
  }

  // ── 5. Insert lead ────────────────────────────────────────────────────────
  const { data: lead, error: insertErr } = await db
    .from('scheduler_leads')
    .insert({
      lead_source:                      widget.lead_source,
      widget_instance_id:               widget.id,
      service_type:                     body.service_type,
      service_category:                 body.service_category,
      diagnostic_answers:               body.diagnostic_answers ?? {},
      customer_first_name:              body.customer_first_name.trim(),
      customer_last_name:               body.customer_last_name.trim(),
      customer_phone:                   body.customer_phone.trim(),
      customer_email:                   body.customer_email.trim().toLowerCase(),
      customer_sms_appointment_consent: body.customer_sms_appointment_consent ?? false,
      customer_sms_marketing_consent:   body.customer_sms_marketing_consent ?? false,
      address_line1:                    body.address_line1.trim(),
      address_line2:                    body.address_line2?.trim() ?? null,
      address_city:                     incomingCity,
      address_state:                    body.address_state?.trim() ?? 'CA',
      address_zip:                      incomingZip,
      address_is_owner:                 body.address_is_owner ?? true,
      address_in_service_area:          inServiceArea,
      appointment_date:                 body.appointment_date,
      appointment_window_start:         body.appointment_window_start,
      appointment_window_end:           body.appointment_window_end,
      appointment_timezone:             'America/Los_Angeles',
      description:                      body.description?.trim() ?? null,
      incentive_applied:                body.incentive_applied?.trim() ?? null,
    })
    .select('id, appointment_date, appointment_window_start, appointment_window_end, address_in_service_area')
    .single()

  if (insertErr || !lead) {
    console.error('[scheduler/bookings] insert error:', insertErr)
    return NextResponse.json({ error: 'Failed to save booking' }, { status: 500, headers: cors })
  }

  return NextResponse.json(
    {
      id: lead.id,
      appointment_date:         lead.appointment_date,
      appointment_window_start: lead.appointment_window_start,
      appointment_window_end:   lead.appointment_window_end,
      in_service_area:          lead.address_in_service_area,
    },
    { status: 201, headers: cors }
  )
}
