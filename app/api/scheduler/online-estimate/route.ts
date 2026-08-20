import { NextRequest, NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { enqueueForSubscribers } from '@/lib/notifications/enqueue'
import { sendEmail } from '@/lib/notifications/resend'
import { renderOnlineEstimateConfirmation } from '@/lib/notifications/templates/online-estimate-confirmation'
import { renderOnlineEstimateAlert } from '@/lib/notifications/templates/online-estimate-alert'
import { createOnlineEstimateInSf } from '@/lib/scheduler/online-estimate'

// Free Online Estimate submission (garage door new-door / new-opener). Like a
// booking, but with NO appointment: we save the lead, create a $0 SF estimate
// for the office to price, email the customer their "we'll get back to you"
// confirmation, and alert the team. Mirrors bookings/route.ts minus the
// appointment/capacity machinery.

const ALLOWED_ORIGINS = [
  'https://schedule.castlegaragedoors.com',
  'https://foxair23.github.io',
  /^http:\/\/localhost:\d+$/,
]

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.some((o) => (typeof o === 'string' ? o === origin : o.test(origin)))
  return {
    'Access-Control-Allow-Origin': allowed ? origin! : 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Castle-Widget-Key',
  }
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) })
}

function serviceClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

interface Payload {
  partial_lead_id?: string
  session_id?: string
  first_name: string
  last_name?: string
  mobile_phone: string
  sms_consent?: boolean
  primary_category: 'garage_door' | 'gate'
  service_type: string
  answers?: Record<string, string | undefined>
  optional_note?: string
  address_line1: string
  address_city: string
  address_state?: string
  address_zip: string
  address_is_owner?: boolean
  customer_email: string
  additional_notes?: string
  widget_key?: string
}

// Server-side guard: only the eligible garage-door install types may use this path.
const ELIGIBLE_TYPES = ['door_panel_replacement', 'opener_service']
function isEligible(p: Payload): boolean {
  if (p.primary_category !== 'garage_door') return false
  if (p.service_type === 'door_panel_replacement') return true
  if (p.service_type === 'opener_service') {
    const need = p.answers?.opener_need
    return need === 'replace' || need === 'add_opener'
  }
  return false
}

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)

export async function POST(req: NextRequest) {
  const cors = corsHeaders(req.headers.get('origin'))

  let body: Payload
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors }) }

  const key = req.headers.get('x-castle-widget-key') || body.widget_key
  if (!key) return NextResponse.json({ error: 'Missing widget key' }, { status: 401, headers: cors })

  const db = serviceClient()
  const { data: widget, error: widgetErr } = await db
    .from('scheduler_widget_instances')
    .select('id, lead_source, sf_job_source, is_active')
    .eq('api_key', key)
    .single()
  if (widgetErr || !widget || !widget.is_active) {
    return NextResponse.json({ error: 'Invalid or inactive widget key' }, { status: 401, headers: cors })
  }

  // Validate
  if (!body.first_name?.trim() || !body.mobile_phone?.trim()) {
    return NextResponse.json({ error: 'Name and phone are required' }, { status: 400, headers: cors })
  }
  if (!ELIGIBLE_TYPES.includes(body.service_type) || !isEligible(body)) {
    return NextResponse.json({ error: 'This service is not eligible for an online estimate' }, { status: 400, headers: cors })
  }
  if (!body.customer_email?.trim() || !isEmail(body.customer_email.trim())) {
    return NextResponse.json({ error: 'A valid email is required to send your estimate' }, { status: 400, headers: cors })
  }
  if (!body.address_line1?.trim() || !body.address_city?.trim() || !body.address_zip?.trim()) {
    return NextResponse.json({ error: 'Address is required' }, { status: 400, headers: cors })
  }

  const leadRow = {
    session_id: body.session_id ?? null,
    is_partial: false,
    estimate_channel: 'online',
    lead_source: widget.lead_source ?? 'website',
    sf_job_source: widget.sf_job_source ?? 'Website',
    widget_instance_id: widget.id,
    service_type: body.primary_category,
    service_category: body.service_type,
    diagnostic_answers: body.answers ?? {},
    customer_first_name: body.first_name.trim(),
    customer_last_name: body.last_name?.trim() || null,
    customer_phone: body.mobile_phone.trim(),
    customer_email: body.customer_email.trim().toLowerCase(),
    customer_sms_appointment_consent: body.sms_consent === true,
    customer_sms_marketing_consent: body.sms_consent === true,
    ...(body.sms_consent === true ? { customer_sms_consent_at: new Date().toISOString(), sms_consent_copy_version: '2026-07-a' } : {}),
    address_line1: body.address_line1.trim(),
    address_city: body.address_city.trim(),
    address_state: body.address_state?.trim() ?? 'CA',
    address_zip: body.address_zip.trim(),
    address_is_owner: body.address_is_owner ?? true,
    // No appointment for an online estimate.
    appointment_date: null,
    appointment_window_start: null,
    appointment_window_end: null,
    description: body.optional_note?.trim() || null,
    additional_notes: body.additional_notes?.trim() || null,
  }

  // Reuse the partial row (created at the contact step) if we have one; else insert.
  let leadId: string | null = null
  if (body.partial_lead_id) {
    const { data } = await db.from('scheduler_leads').update(leadRow).eq('id', body.partial_lead_id).select('id').single()
    if (data) leadId = data.id as string
  }
  if (!leadId && body.session_id) {
    const { data: existing } = await db.from('scheduler_leads').select('id').eq('session_id', body.session_id).eq('is_partial', true).maybeSingle()
    if (existing) {
      const { data } = await db.from('scheduler_leads').update(leadRow).eq('id', (existing as { id: string }).id).select('id').single()
      if (data) leadId = data.id as string
    }
  }
  if (!leadId) {
    const { data, error: insErr } = await db.from('scheduler_leads').insert({ ...leadRow, session_id: null }).select('id').single()
    if (insErr || !data) {
      console.error('[scheduler/online-estimate] insert error:', insErr?.message)
      return NextResponse.json({ error: insErr?.message ?? 'Failed to save your request' }, { status: 500, headers: cors })
    }
    leadId = data.id as string
  }

  const finalLeadId = leadId
  const customerEmail = body.customer_email.trim().toLowerCase()
  const customerName = [body.first_name.trim(), body.last_name?.trim()].filter(Boolean).join(' ')
  const serviceLabel = body.service_type === 'door_panel_replacement'
    ? 'Garage Door — New Door / Panel'
    : `Garage Door Opener — ${body.answers?.opener_need === 'add_opener' ? 'Add Opener' : 'Replace Opener'}`
  const adminUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://castleadmin.vercel.app'}/admin/action-items?tab=online-estimates`

  after(async () => {
    // 1. Create the $0 SF estimate (best-effort — review-only on failure).
    let estimateNumber: string | undefined
    try {
      const res = await createOnlineEstimateInSf(finalLeadId)
      estimateNumber = res.estimateNumber
    } catch { /* leaves the lead review-only */ }

    // 2. Customer confirmation ("we'll email your estimate").
    const conf = renderOnlineEstimateConfirmation({ customerFirstName: body.first_name.trim(), serviceLabel })
    await sendEmail({ to: customerEmail, subject: conf.subject, html: conf.bodyHtml, text: conf.bodyText, replyTo: 'info@castlegaragedoors.com' }).catch(() => {})

    // 3. Team alert.
    const alert = renderOnlineEstimateAlert({
      customerName, phone: body.mobile_phone.trim(), email: customerEmail, serviceLabel,
      address: [body.address_line1.trim(), body.address_city.trim(), body.address_state ?? 'CA', body.address_zip.trim()].join(', '),
      estimateNumber, adminUrl,
    })
    await enqueueForSubscribers({
      notificationTypeKey: 'scheduler_online_estimate',
      subject: alert.subject, bodyHtml: alert.bodyHtml, bodyText: alert.bodyText,
      relatedEntityType: 'scheduler_lead', relatedEntityId: finalLeadId,
    }).catch(() => {})
  })

  return NextResponse.json({ id: finalLeadId }, { status: 201, headers: cors })
}
