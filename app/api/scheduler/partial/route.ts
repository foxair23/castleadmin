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

  // Plain insert — no upsert/conflict logic needed for partial leads
  const { data, error } = await db
    .from('scheduler_leads')
    .insert({
      session_id,
      is_partial: true,
      lead_source: widget.lead_source ?? 'website',
      widget_instance_id: widget.id,
      customer_first_name: first_name.trim(),
      customer_phone: mobile_phone.trim(),
      address_zip: zip?.trim() || null,
    })
    .select('id')
    .single()

  if (error) {
    console.error('[partial] insert error:', error.message, error.details)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ id: (data as { id: string }).id })
}
