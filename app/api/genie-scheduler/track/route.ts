import { NextRequest, NextResponse } from 'next/server'
import { schedulerOrigins } from '@/lib/config/domains'
import { createClient } from '@supabase/supabase-js'

// Genie self-scheduler funnel tracking. The client POSTs a lightweight event at
// each step so we can see where customers drop off. Widget-key gated like the
// rest of the scheduler; always best-effort (never blocks the flow) and stores
// no PII beyond an anonymous session id + optional HD order number.

export const dynamic = 'force-dynamic'

const ALLOWED_ORIGINS = [
  ...schedulerOrigins(),
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

const STEPS = new Set([
  'start', 'lookup_attempt', 'lookup_found', 'lookup_not_found',
  'reached_qualification', 'qualification_done',
  'reached_scheduling', 'saw_zero_slots', 'selected_slot', 'booked',
])

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) })
}

export async function POST(req: NextRequest) {
  const cors = corsHeaders(req.headers.get('origin'))
  const widgetKey = req.headers.get('x-castle-widget-key')
  if (!widgetKey) return NextResponse.json({ ok: false }, { status: 401, headers: cors })

  const db = serviceClient()
  const { data: widget } = await db.from('scheduler_widget_instances').select('id, is_active').eq('api_key', widgetKey).single()
  if (!widget || !widget.is_active) return NextResponse.json({ ok: false }, { status: 401, headers: cors })

  let body: { session_id?: string; step?: string; order_number?: string; detail?: Record<string, unknown> }
  try { body = await req.json() } catch { return NextResponse.json({ ok: false }, { status: 200, headers: cors }) }

  const sessionId = String(body.session_id ?? '').slice(0, 64)
  const step = String(body.step ?? '')
  if (!sessionId || !STEPS.has(step)) return NextResponse.json({ ok: true }, { status: 200, headers: cors })

  try {
    await db.from('genie_funnel_events').insert({
      session_id: sessionId,
      step,
      order_number: body.order_number ? String(body.order_number).slice(0, 32) : null,
      detail: body.detail && typeof body.detail === 'object' ? body.detail : {},
    })
  } catch { /* best-effort: never block the funnel */ }

  return NextResponse.json({ ok: true }, { status: 200, headers: cors })
}
