import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { after } from 'next/server'
import { enqueueForSubscribers, enqueueNotification } from '@/lib/notifications/enqueue'
import { renderSchedulerLeadStuck } from '@/lib/notifications/templates/scheduler-lead-stuck'

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
  session_id: string
  widget_key: string
}

export async function POST(req: NextRequest) {
  let body: PartialPayload
  try {
    body = await req.json() as PartialPayload
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { zip, first_name, mobile_phone, session_id, widget_key } = body

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

  const leadFields = {
    customer_first_name: first_name.trim(),
    customer_phone: mobile_phone.trim(),
    address_zip: zip?.trim() || null,
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

  const newLeadId = (data as { id: string }).id
  const customerName = first_name.trim()
  const phoneNumber = mobile_phone.trim()
  const adminUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://castleadmin.vercel.app'}/admin/scheduler`

  after(async () => {
    const { bodyHtml, bodyText } = renderSchedulerLeadStuck({
      customerName,
      phoneNumber,
      serviceLabel: 'Incomplete submission',
      appointmentDate: '—',
      reason: 'manual_push',
      adminUrl,
    })
    const subject = 'Action Item: Partial Lead'

    // Notify subscribers (admin users who opted in to scheduler_lead_stuck)
    await enqueueForSubscribers({
      notificationTypeKey: 'scheduler_lead_stuck',
      subject,
      bodyHtml,
      bodyText,
      relatedEntityType: 'scheduler_lead',
      relatedEntityId: newLeadId,
    }).catch(() => { /* non-critical */ })

    // Also notify all sales users unconditionally
    const { data: salesUsers } = await db
      .from('profiles')
      .select('id')
      .eq('role', 'sales')
      .eq('is_active', true)

    await Promise.all(
      (salesUsers ?? []).map((u: { id: string }) =>
        enqueueNotification({
          notificationTypeKey: 'scheduler_lead_stuck',
          userId: u.id,
          subject,
          bodyHtml,
          bodyText,
          relatedEntityType: 'scheduler_lead',
          relatedEntityId: newLeadId,
        }).catch(() => { /* non-critical */ })
      )
    )
  })

  return NextResponse.json({ id: newLeadId })
}
