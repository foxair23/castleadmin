import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { resolveSfJobMatches } from '@/lib/vendor-orders/sf-match'

// Genie self-scheduler — step 1: a customer proves who they are with the phone
// or email on their Home Depot / Genie order. We match it to a vendor_orders row
// that already has an SF job (create-sf-job.ts) and return just enough to
// confirm ("is this your order?"). The phone/email itself is the gate — we only
// return an order when the supplied contact actually matches it.

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

const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '')

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) })
}

export async function POST(req: NextRequest) {
  const cors = corsHeaders(req.headers.get('origin'))
  const db = serviceClient()

  // Validate the widget key (same gate the rest of the scheduler uses).
  const widgetKey = req.headers.get('x-castle-widget-key')
  if (!widgetKey) return NextResponse.json({ error: 'Missing widget key' }, { status: 401, headers: cors })
  const { data: widget } = await db.from('scheduler_widget_instances').select('id, is_active').eq('api_key', widgetKey).single()
  if (!widget || !widget.is_active) return NextResponse.json({ error: 'Invalid or inactive widget key' }, { status: 401, headers: cors })

  let body: { phone?: string; email?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400, headers: cors }) }

  const phone = digits(body.phone)
  const email = (body.email ?? '').trim().toLowerCase()
  // Require one usable identifier: a 10-digit phone or a plausible email.
  if (phone.length < 10 && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: 'Enter the phone number or email from your order.' }, { status: 400, headers: cors })
  }
  const phone10 = phone.slice(-10)

  // Match against ALL non-cancelled Genie orders (~hundreds), by digit-normalized
  // phone / lowercased email so formatting differences ('(760) 555-1212' vs
  // '7605551212') still hit.
  const { data: orders } = await db
    .from('vendor_orders')
    .select('id, external_id, sf_created_job_number, sf_job_id, status, customer_name, customer_po, street_address, city, state_prov, postal_code, scope, phone, email, appointment_date, appointment_window_start, appointment_window_end')
    .eq('vendor', 'genie_thd')
    .neq('status', 'Cancelled')

  type Order = NonNullable<typeof orders>[number]
  const matched: Order[] = (orders ?? []).filter((o) => {
    const byPhone = phone10.length === 10 && digits(o.phone).slice(-10) === phone10
    const byEmail = !!email && (o.email ?? '').trim().toLowerCase() === email
    return byPhone || byEmail
  })

  const toResult = (o: Order, sfJobNumber: string | null) => ({
    order_id: o.id,
    order_number: o.external_id,
    sf_job_number: sfJobNumber,
    customer_name: o.customer_name,
    street_address: o.street_address,
    city: o.city,
    state_prov: o.state_prov,
    postal_code: o.postal_code,
    scope: o.scope,
    already_scheduled: o.appointment_date
      ? { date: o.appointment_date, window_start: o.appointment_window_start, window_end: o.appointment_window_end }
      : null,
  })

  // Orders we already created a job for are schedulable immediately — no need to
  // load the SF mirror. Only fall back to the matching service for matched orders
  // that DON'T have a job, and never let that (heavy) call fail the whole lookup.
  const results: ReturnType<typeof toResult>[] = []
  const needMatch: Order[] = []
  for (const o of matched) {
    if (o.sf_job_id) results.push(toResult(o, o.sf_created_job_number ?? null))
    else needMatch.push(o)
  }
  if (needMatch.length) {
    try {
      const jobMatches = await resolveSfJobMatches(db, needMatch.map((o) => ({
        id: o.id, customer_po: o.customer_po, customer_name: o.customer_name, email: o.email, phone: o.phone, sf_job_id: o.sf_job_id,
      })))
      for (const o of needMatch) {
        const m = jobMatches.get(o.id)
        if (m?.sfJobId) results.push(toResult(o, o.sf_created_job_number ?? m.sfJobNumber ?? null))
      }
    } catch (e) {
      console.error('[genie-lookup] job matching failed (returning direct matches only):', e)
    }
  }

  // Temporary diagnostics (non-sensitive counts) to pinpoint why a known order
  // isn't found in production. Remove once resolved.
  return NextResponse.json({
    matches: results,
    debug: {
      scanned: (orders ?? []).length,   // genie orders the query returned
      matched: matched.length,          // matched this phone/email
      withJob: results.length,          // of matched, resolvable to an SF job
      gotEmail: !!email,
    },
  }, { status: 200, headers: cors })
}
