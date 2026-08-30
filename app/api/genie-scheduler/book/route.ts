import { NextRequest, NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { sfPut } from '@/lib/crm/service-fusion'
import { enqueueNote } from '@/lib/sf-notes/queue'
import { resolveSfJobMatches } from '@/lib/vendor-orders/sf-match'
import { sendEmail } from '@/lib/notifications/resend'
import { enqueueForSubscribers } from '@/lib/notifications/enqueue'
import { greetingFirstName } from '@/lib/names'
import { renderGenieBookingConfirmation, renderGenieBookingAlert } from '@/lib/notifications/templates/genie-booking'

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

function buildNote(orderNumber: string, date: string, start: string | null, end: string | null, a: GenieAnswers): string {
  const flags: string[] = []
  if (a.adult_present === false) flags.push('⚠ No adult (18+) confirmed present during install')
  if (a.clearance_10ft === false) flags.push('⚠ Garage NOT confirmed cleared back 10 ft')
  if (a.outlet_within_3ft === 'no') flags.push('⚠ No working outlet within 3 ft of opener location')
  if (a.outlet_within_3ft === 'unsure') flags.push('⚠ Customer unsure about an outlet within 3 ft')
  if (a.door_over_7ft) flags.push('⚠ Door over 7 ft — extension rail likely required (possible added charge / HD sourcing)')

  const lines = [
    `Customer self-scheduled via the Genie scheduler (HD order ${orderNumber}).`,
    start && end ? `Requested: ${date}, ${windowLabel(start, end)} PT.` : `Requested: ${date} (any time — tech to call ahead).`,
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
  if (!order_id || !appointment_date) {
    return NextResponse.json({ error: 'Missing appointment details.' }, { status: 400, headers: cors })
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(appointment_date)) {
    return NextResponse.json({ error: 'Bad appointment format.' }, { status: 400, headers: cors })
  }

  // Read Genie scheduler config (min lead time + slot mode) up front.
  const { data: settingRows } = await db.from('scheduler_settings').select('key, value').in('key', ['genie_min_lead_days', 'genie_slot_mode'])
  const settings: Record<string, unknown> = {}
  for (const r of settingRows ?? []) settings[r.key] = r.value
  const slotMode = settings.genie_slot_mode === 'day' ? 'day' : 'windows'

  // In 'windows' mode a valid time window is required; in 'day' mode it's ignored.
  const hasWindow = !!window_start && !!window_end
  if (slotMode === 'windows') {
    if (!hasWindow || !/^\d{2}:\d{2}$/.test(window_start!) || !/^\d{2}:\d{2}$/.test(window_end!)) {
      return NextResponse.json({ error: 'Please pick an arrival window.' }, { status: 400, headers: cors })
    }
  }
  const useWindow = slotMode === 'windows' && hasWindow

  // Enforce the minimum lead time (motor must ship first) server-side too, so a
  // stale client or a direct POST can't book sooner than the configured window.
  const minLeadDays = Number(settings.genie_min_lead_days ?? 7) || 0
  const todayLA = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const earliest = new Date(todayLA + 'T12:00:00Z'); earliest.setUTCDate(earliest.getUTCDate() + minLeadDays)
  if (appointment_date < earliest.toISOString().slice(0, 10)) {
    return NextResponse.json({ error: `The earliest available date is ${earliest.toISOString().slice(0, 10)}. Please pick a later date.` }, { status: 400, headers: cors })
  }

  const { data: order } = await db
    .from('vendor_orders')
    .select('id, external_id, status, sf_job_id, sf_created_job_number, customer_po, customer_name, email, phone, street_address, city, state_prov, postal_code')
    .eq('id', order_id)
    .single()
  if (!order) return NextResponse.json({ error: 'Order not found.' }, { status: 404, headers: cors })
  if (order.status === 'Cancelled') return NextResponse.json({ error: 'This order has been cancelled.' }, { status: 409, headers: cors })

  // Resolve the SF job to write to: the one we created (sf_job_id) or, for orders
  // matched to a pre-existing job, the one the shared matching service finds.
  let sfJobId: string | null = order.sf_job_id
  let sfJobNumber: string | null = order.sf_created_job_number
  if (!sfJobId) {
    const m = (await resolveSfJobMatches(db, [{ id: order.id, customer_po: order.customer_po, customer_name: order.customer_name, email: order.email, phone: order.phone, sf_job_id: order.sf_job_id }])).get(order.id)
    sfJobId = m?.sfJobId ?? null
    sfJobNumber = sfJobNumber ?? m?.sfJobNumber ?? null
  }
  if (!sfJobId) {
    // The customer IDENTIFIED successfully but the job can't be resolved (typically the
    // SF mirror hasn't synced a manually-created job yet). Capture it as a Genie partial
    // lead — we know exactly who they are here — so the office sees it in Action Items
    // and the Partial Lead email instead of the customer silently giving up.
    try {
      const nameParts = (order.customer_name ?? '').trim().split(/\s+/)
      const phoneVal = (body.contact_phone ?? order.phone ?? '').trim() || null
      const emailVal = (body.contact_email ?? order.email ?? '').trim() || null
      let dedupe = db.from('scheduler_leads').select('id')
        .eq('is_partial', true).eq('lead_source', 'genie').is('acknowledged_at', null)
      if (phoneVal) dedupe = dedupe.eq('customer_phone', phoneVal)
      else if (emailVal) dedupe = dedupe.eq('customer_email', emailVal)
      else dedupe = dedupe.eq('customer_last_name', nameParts.slice(-1)[0] ?? '')
      const { data: existing } = await dedupe.limit(1).maybeSingle()
      if (!existing) {
        await db.from('scheduler_leads').insert({
          session_id: `genie-book-${crypto.randomUUID()}`,
          is_partial: true,
          lead_source: 'genie',
          widget_instance_id: widget.id,
          customer_first_name: nameParts.length > 1 ? nameParts.slice(0, -1).join(' ') : (nameParts[0] || null),
          customer_last_name: nameParts.length > 1 ? nameParts.slice(-1)[0] : null,
          customer_phone: phoneVal,
          customer_email: emailVal,
          address_zip: order.postal_code ?? null,
        })
      }
    } catch (e) { console.error('[genie-book] partial-lead capture failed (non-critical):', e) }
    return NextResponse.json({ error: 'We couldn’t find your job in our system. Please call the office.' }, { status: 409, headers: cors })
  }

  const answers: GenieAnswers = body.answers ?? {}

  // 1) Write the schedule onto the existing SF job. Retry transient failures
  //    (5xx/429/timeout/network) with backoff — SF intermittently 500s/429s.
  //    We still record the request below either way, and if this ultimately
  //    fails the customer is told it's not yet confirmed and the office alert is
  //    flagged so a human sets the date manually (rather than a silent success).
  let sfSynced = false
  let sfError: string | null = null
  const putBody = {
    start_date: appointment_date,
    ...(useWindow ? { time_frame_promised_start: window_start, time_frame_promised_end: window_end } : {}),
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await sfPut(`/jobs/${sfJobId}`, putBody)
      sfSynced = true
      sfError = null
      break
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      sfError = msg
      const transient = /\(5\d\d\)|\(429\)|busy|abort|network|fetch failed|timeout/i.test(msg)
      if (!transient || attempt === 2) break
      await new Promise(r => setTimeout(r, 500 * 2 ** attempt)) // 0.5s, 1s
    }
  }

  // 2) Queue the qualification note (posted to SF by the extension). Dedup per
  //    order + chosen slot so a genuine reschedule posts a fresh note.
  await enqueueNote({
    sfJobId,
    noteText: buildNote(order.external_id, appointment_date, useWindow ? window_start! : null, useWindow ? window_end! : null, answers),
    event: 'genie_schedule',
    dedupKey: `genie_sched:${order.id}:${appointment_date}:${useWindow ? window_start : 'day'}`,
    refTable: 'vendor_orders',
    refId: order.id,
  })

  // 3) Record the appointment on the order + timeline (source of truth).
  const nowIso = new Date().toISOString()
  await db.from('vendor_orders').update({
    appointment_date,
    appointment_window_start: useWindow ? window_start : null,
    appointment_window_end: useWindow ? window_end : null,
    scheduled_at: nowIso,
    scheduled_contact_phone: body.contact_phone ?? null,
    scheduled_contact_email: body.contact_email ?? null,
    schedule_answers: answers,
    updated_at: nowIso,
  }).eq('id', order.id)

  await db.from('vendor_order_events').insert({
    order_id: order.id,
    event_type: 'scheduled',
    to_value: useWindow ? `${appointment_date} ${window_start}-${window_end}` : appointment_date,
    detail: { sfSynced, sfError, slotMode, answers },
  })

  // If an earlier failed lookup captured this customer as a Genie partial lead, the
  // problem is now solved — acknowledge it so the office isn't asked to chase a
  // customer who already booked. Matched by the contacts we know for the order.
  try {
    const contacts: Array<{ col: string; val: string }> = []
    for (const v of [body.contact_phone, order.phone]) if (v?.trim()) contacts.push({ col: 'customer_phone', val: v.trim() })
    for (const v of [body.contact_email, order.email]) if (v?.trim()) contacts.push({ col: 'customer_email', val: v.trim() })
    const nowAck = new Date().toISOString()
    for (const c of contacts) {
      await db.from('scheduler_leads')
        .update({ acknowledged_at: nowAck, partial_notified_at: nowAck })
        .eq('is_partial', true).eq('lead_source', 'genie').is('acknowledged_at', null)
        .eq(c.col, c.val)
    }
  } catch { /* non-critical */ }

  // 4) Notify (non-blocking, best-effort): a confirmation email to the customer
  //    and a team alert on the same subscriber path as the main scheduler.
  const dateLabel = new Date(appointment_date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  const windowText = useWindow ? windowLabel(window_start!, window_end!) : 'Any time — our tech will call ahead'
  const addressText = [order.street_address, order.city, order.state_prov, order.postal_code].filter(Boolean).join(', ') || null
  const customerEmail = order.email || body.contact_email || null
  const greetingName = greetingFirstName({ customerName: order.customer_name })
  const adminUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://castleadmin.vercel.app'}/admin/vendor-orders`

  after(async () => {
    if (customerEmail) {
      const { subject, html, text } = renderGenieBookingConfirmation({ greetingName, dateLabel, windowLabel: windowText, address: addressText })
      await sendEmail({ to: customerEmail, subject, html, text, replyTo: 'info@castlegaragedoors.com' }).catch(() => { /* non-critical */ })
    }
    const alert = renderGenieBookingAlert({
      customerName: order.customer_name, phone: order.phone, email: customerEmail,
      hdOrder: order.external_id, sfJobNumber, dateLabel, windowLabel: windowText, address: addressText, adminUrl,
      synced: sfSynced, syncError: sfError,
    })
    await enqueueForSubscribers({
      notificationTypeKey: 'scheduler_lead_synced',
      subject: alert.subject, bodyHtml: alert.bodyHtml, bodyText: alert.bodyText,
      relatedEntityType: 'vendor_orders', relatedEntityId: order.id,
    }).catch(() => { /* non-critical */ })
  })

  return NextResponse.json({
    ok: true,
    sf_synced: sfSynced,
    order_number: order.external_id,
    sf_job_number: sfJobNumber,
    appointment_date,
    window_start,
    window_end,
  }, { status: 200, headers: cors })
}
