import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

interface PartialPayload {
  zip: string
  first_name: string
  mobile_phone: string
  sms_consent?: boolean
  session_id: string
  widget_key: string
}

// Approved SMS opt-in disclosure version — stored on the lead as the exact copy
// the customer saw, for the TCPA audit trail. Bump when the wording changes.
const SMS_CONSENT_COPY_VERSION = '2026-07-a'

export async function POST(req: NextRequest) {
  let body: PartialPayload
  try {
    body = await req.json() as PartialPayload
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { zip, first_name, mobile_phone, sms_consent, session_id, widget_key } = body

  if (!first_name?.trim() || !mobile_phone?.trim() || !session_id?.trim() || !widget_key?.trim()) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  const db = serviceClient()

  // Validate widget key
  const { data: widget } = await db
    .from('scheduler_widget_instances')
    .select('id, lead_source, is_active')
    .eq('api_key', widget_key)
    .single()

  if (!widget || !widget.is_active) {
    return NextResponse.json({ error: 'Invalid widget key' }, { status: 401 })
  }

  // The single combined opt-in covers both appointment and promotional texts,
  // so it sets both consent flags. consent_at/version give a proof-of-consent
  // audit trail; only stamped when they actually opted in.
  const consented = sms_consent === true
  const leadFields = {
    customer_first_name: first_name.trim(),
    customer_phone: mobile_phone.trim(),
    address_zip: zip?.trim() || null,
    customer_sms_appointment_consent: consented,
    customer_sms_marketing_consent: consented,
    customer_sms_consent_at: consented ? new Date().toISOString() : null,
    sms_consent_copy_version: consented ? SMS_CONSENT_COPY_VERSION : null,
  }

  // If a partial lead already exists for this session, update and return it.
  const { data: existing } = await db
    .from('scheduler_leads')
    .select('id')
    .eq('session_id', session_id)
    .eq('is_partial', true)
    .maybeSingle()

  if (existing) {
    await db.from('scheduler_leads').update(leadFields).eq('id', (existing as { id: string }).id)
    return NextResponse.json({ id: (existing as { id: string }).id })
  }

  const { data, error } = await db
    .from('scheduler_leads')
    .insert({
      session_id,
      is_partial: true,
      lead_source: widget.lead_source ?? 'website',
      widget_instance_id: widget.id,
      ...leadFields,
    })
    .select('id')
    .single()

  if (error) {
    console.error('[partial] insert error:', error.code, error.message, error.details)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // The "Partial Lead" alert is NOT sent here. A cron sends it only if the
  // booking is still incomplete after a 15-minute grace window (see
  // /api/cron/scheduler-partial-leads), so slow-but-completing customers don't
  // trigger a false partial alert.
  const newLeadId = (data as { id: string }).id
  return NextResponse.json({ id: newLeadId })
}
