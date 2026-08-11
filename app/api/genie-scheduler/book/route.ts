import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { sfPut } from '@/lib/crm/service-fusion'
import { enqueueNote } from '@/lib/sf-notes/queue'

// Genie self-scheduler — final step: write the chosen appointment onto the SF
// job we already created for this order, and queue a note summarizing the
// customer's pre-install qualification answers.
//
// SF has no API to add a note to a job, so the note is enqueued (sf_note_queue)
// and the browser extension posts it in the logged-in session. The schedule
// itself IS an API write (sfPut /jobs/{id}). We record the appointment on the
// vendor_orders row regardless, so a transient SF hiccup never loses the booking
// — the office sees the request either way.

export const dynamic = 'force-dynamic'

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
    'Cache-Control': 'no-store',
  }
}
function serviceClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export interface GenieAnswers {
  door_type?: 'metal_sectional' | 'one_piece_wood' | string
  door_over_7ft?: boolean
  clearance_10ft?: boolean
  adult_present?: boolean
  outlet_within_3ft?: 'yes' | 'no' | 'unsure' | string
  notes?: string
}

const LABEL: Record<string, string> = {
  metal_sectional: 'Metal sectional',
  one_piece_wood: 'One-piece wood',
  yes: 'Yes',
  no: 'No',
  unsure: 'Not sure',
}
const yn = (v: boolean | undefined) => (v === true ? 'Yes' : v === false ? 'No' : '—')

// Human-readable window label for the note ('08:00'→'12:00' ⇒ '8 AM – 12 PM').
function windowLabel(start?: string, end?: string): string {
  const fmt = (t?: string) => {
    if (!t) return ''
    const [h, m] = t.split(':').map(Number)
    const ampm = h < 12 ? 'AM' : 'PM'
    const h12 = h % 12 === 0 ? 12 : h % 12
    return m ? `${h12}:${String(m).padStart(2, '0')} ${ampm}` : `${h12} ${ampm}`
  }
  return `${fmt(start)} – ${fmt(end)}`
}

function buildNote(orderNumber: string, date: string, start: string, end: string, a: GenieAnswers): string {
  const flags: string[] = []
  if (a.adult_present === false) flags.push('⚠ No adult (18+) confirmed present during install')
  if (a.clearance_10ft === false) flags.push('⚠ Garage NOT confirmed cleared back 10 ft')
  if (a.outlet_within_3ft === 'no') flags.push('⚠ No working outlet within 3 ft of opener location')
  if (a.outlet_within_3ft === 'unsure') flags.push('⚠ Customer unsure about an outlet within 3 ft')
  if (a.door_over_7ft) flags.push('⚠ Door over 7 ft — extension rail likely required (possible added charge / HD sourcing)')

  const lines = [
    `Customer self-scheduled via the Genie scheduler (HD order ${orderNumber}).`,
    `Requested: ${date}, ${windowLabel(start, end)} PT.`,
    '',
    'Pre-install qualification:',
    `• Door type: ${a.door_type ? (LABEL[a.door_type] ?? a.door_type) : '—'}`,
    `• Door over 7 ft: ${yn(a.door_over_7ft)}`,
    `• Garage cleared back 10 ft: ${yn(a.clearance_10ft)}`,
    `• Adult 18+ present during install: ${yn(a.adult_present)}`,
    `• Working outlet within 3 ft: ${a.outlet_within_3ft ? (LABEL[a.outlet_within_3ft] ?? a.outlet_within_3ft) : '—'}`,
  ]
  if (a.notes && a.notes.trim()) lines.push('', `Customer notes: ${a.notes.trim()}`)
  if (flags.length) lines.push('', 'NEEDS ATTENTION:', ...flags)
  return lines.join('\n')
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) })
}

export async function POST(req: NextRequest) {
  const cors = corsHeaders(req.headers.get('origin'))
  const db = serviceClient()

  const widgetKey = req.headers.get('x-castle-widget-key')
  if (!widgetKey) return NextResponse.json({ error: 'Missing widget key' }, { status: 401, headers: cors })
  const { data: widget } = await db.from('scheduler_widget_instances').select('id, is_active').eq('api_key', widgetKey).single()
  if (!widget || !widget.is_active) return NextResponse.json({ error: 'Invalid or inactive widget key' }, { status: 401, headers: cors })

  let body: {
    order_id?: string
    appointment_date?: string
    window_start?: string
    window_end?: string
    contact_phone?: string
    contact_email?: string
    answers?: GenieAnswers
  }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400, headers: cors }) }

  const { order_id, appointment_date, window_start, window_end } = body
  if (!order_id || !appointment_date || !window_start || !window_end) {
    return NextResponse.json({ error: 'Missing appointment details.' }, { status: 400, headers: cors })
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(appointment_date) || !/^\d{2}:\d{2}$/.test(window_start) || !/^\d{2}:\d{2}$/.test(window_end)) {
    return NextResponse.json({ error: 'Bad appointment format.' }, { status: 400, headers: cors })
  }

  const { data: order } = await db
    .from('vendor_orders')
    .select('id, external_id, status, sf_job_id, sf_created_job_number')
    .eq('id', order_id)
    .single()
  if (!order || !order.sf_job_id) return NextResponse.json({ error: 'Order not found.' }, { status: 404, headers: cors })
  if (order.status === 'Cancelled') return NextResponse.json({ error: 'This order has been cancelled.' }, { status: 409, headers: cors })

  const answers: GenieAnswers = body.answers ?? {}

  // 1) Write the schedule onto the existing SF job (best-effort — we still record
  //    the request below if this fails, and the queued note carries the date).
  let sfSynced = false
  let sfError: string | null = null
  try {
    await sfPut(`/jobs/${order.sf_job_id}`, {
      start_date: appointment_date,
      time_frame_promised_start: window_start,
      time_frame_promised_end: window_end,
    })
    sfSynced = true
  } catch (e) {
    sfError = e instanceof Error ? e.message : String(e)
  }

  // 2) Queue the qualification note (posted to SF by the extension). Dedup per
  //    order + chosen slot so a genuine reschedule posts a fresh note.
  await enqueueNote({
    sfJobId: order.sf_job_id,
    noteText: buildNote(order.external_id, appointment_date, window_start, window_end, answers),
    event: 'genie_schedule',
    dedupKey: `genie_sched:${order.id}:${appointment_date}:${window_start}`,
    refTable: 'vendor_orders',
    refId: order.id,
  })

  // 3) Record the appointment on the order + timeline (source of truth).
  const nowIso = new Date().toISOString()
  await db.from('vendor_orders').update({
    appointment_date,
    appointment_window_start: window_start,
    appointment_window_end: window_end,
    scheduled_at: nowIso,
    scheduled_contact_phone: body.contact_phone ?? null,
    scheduled_contact_email: body.contact_email ?? null,
    schedule_answers: answers,
    updated_at: nowIso,
  }).eq('id', order.id)

  await db.from('vendor_order_events').insert({
    order_id: order.id,
    event_type: 'scheduled',
    to_value: `${appointment_date} ${window_start}-${window_end}`,
    detail: { sfSynced, sfError, answers },
  })

  return NextResponse.json({
    ok: true,
    sf_synced: sfSynced,
    order_number: order.external_id,
    sf_job_number: order.sf_created_job_number,
    appointment_date,
    window_start,
    window_end,
  }, { status: 200, headers: cors })
}
