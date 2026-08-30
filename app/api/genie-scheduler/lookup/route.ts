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
  const { data: widget } = await db.from('scheduler_widget_instances').select('id, lead_source, is_active').eq('api_key', widgetKey).single()
  if (!widget || !widget.is_active) return NextResponse.json({ error: 'Invalid or inactive widget key' }, { status: 401, headers: cors })

  let body: { phone?: string; email?: string; last_name?: string; postal_code?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400, headers: cors }) }

  const phone = digits(body.phone)
  const email = (body.email ?? '').trim().toLowerCase()
  // Name + ZIP fallback — two factors so it isn't a privacy leak like name alone.
  const lastName = (body.last_name ?? '').trim().toLowerCase()
  const zip5 = digits(body.postal_code).slice(0, 5)

  const phone10 = phone.slice(-10)
  const hasPhone = phone10.length === 10
  const hasEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
  const hasNameZip = lastName.length >= 2 && zip5.length === 5

  // Require at least one usable identifier.
  if (!hasPhone && !hasEmail && !hasNameZip) {
    return NextResponse.json({ error: 'Enter your phone, email, or last name + ZIP code.' }, { status: 400, headers: cors })
  }

  // Match against ALL non-cancelled Genie orders (~hundreds). Phone/email are
  // digit-/case-normalized; name+ZIP matches a customer whose name contains the
  // last name AND whose order ZIP matches (both required). The crawled
  // phone/email are often missing, so name+ZIP is the reliable fallback.
  // (Order-number lookup was removed — the number Home Depot shows the customer
  // differs from the external_id Genie gives us.)
  const { data: orders } = await db
    .from('vendor_orders')
    .select('id, external_id, sf_created_job_number, sf_job_id, status, customer_name, customer_po, street_address, city, state_prov, postal_code, scope, phone, email, appointment_date, appointment_window_start, appointment_window_end')
    .eq('vendor', 'genie_thd')
    .neq('status', 'Cancelled')

  type Order = NonNullable<typeof orders>[number]
  const matched: Order[] = (orders ?? []).filter((o) => {
    const byPhone = hasPhone && digits(o.phone).slice(-10) === phone10
    const byEmail = hasEmail && (o.email ?? '').trim().toLowerCase() === email
    const byNameZip = hasNameZip
      && (o.customer_name ?? '').toLowerCase().includes(lastName)
      && digits(o.postal_code).slice(0, 5) === zip5
    return byPhone || byEmail || byNameZip
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

  // Observability: log each attempt (masked identifier, match counts) so a
  // "not recognized" complaint is diagnosable — raw_matched=0 means nothing
  // matched the identifier; raw_matched>0 with returned=0 means it matched but
  // was dropped for lacking a resolvable SF job. Best-effort; never blocks.
  try {
    let method = 'unknown', identifierMasked = ''
    if (hasPhone) { method = 'phone'; identifierMasked = `***${phone10.slice(-4)}` }
    else if (hasEmail) { method = 'email'; identifierMasked = `${email.slice(0, 1)}***@${email.split('@')[1] ?? ''}` }
    else if (hasNameZip) { method = 'name'; identifierMasked = `${lastName} ${zip5}` }
    await db.from('genie_lookup_events').insert({
      method, identifier_masked: identifierMasked.slice(0, 80),
      raw_matched: matched.length, returned: results.length,
    })
  } catch { /* non-critical */ }

  // A customer who got our schedule nudge but can't find their order used to vanish
  // silently (the Genie flow wrote no partial lead at all). Capture the failure as a
  // partial scheduler_lead — labeled with the widget's lead_source ('genie') — so it
  // surfaces in Action Items → Online Scheduling and the Partial Lead email, with
  // whatever contact info they typed so the office can call them back. Deduped by
  // contact so repeated attempts don't spam rows; best-effort, never fails the lookup.
  if (results.length === 0) {
    try {
      const rawPhone = (body.phone ?? '').trim()
      const rawEmail = (body.email ?? '').trim()
      const rawLast = (body.last_name ?? '').trim()
      let dedupe = db.from('scheduler_leads').select('id')
        .eq('is_partial', true).eq('lead_source', widget.lead_source ?? 'genie').is('acknowledged_at', null)
      if (hasPhone) dedupe = dedupe.eq('customer_phone', rawPhone)
      else if (hasEmail) dedupe = dedupe.eq('customer_email', rawEmail)
      else dedupe = dedupe.eq('customer_last_name', rawLast).eq('address_zip', zip5)
      const { data: existing } = await dedupe.limit(1).maybeSingle()
      if (!existing) {
        await db.from('scheduler_leads').insert({
          session_id: `genie-lookup-${crypto.randomUUID()}`,
          is_partial: true,
          lead_source: widget.lead_source ?? 'genie',
          widget_instance_id: widget.id,
          customer_last_name: rawLast || null,
          customer_phone: hasPhone ? rawPhone : null,
          customer_email: hasEmail ? rawEmail : null,
          address_zip: zip5 || null,
        })
      }
    } catch (e) { console.error('[genie-lookup] partial-lead capture failed (non-critical):', e) }
  }

  return NextResponse.json({ matches: results }, { status: 200, headers: cors })
}
