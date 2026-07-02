import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { periodForRecognitionDate } from '@/lib/commission/periods'
import { planFingerprint, fmtPeriodLabel, type PlanTerms } from '@/lib/commission/acceptance'
import { LEGAL_VERSION } from '@/lib/commission/legal-agreement'
import { renderCommissionAcceptanceEmail } from '@/lib/notifications/templates/commission'
import { sendEmail } from '@/lib/notifications/resend'

const COMPLIANCE_BCC = 'john@castlegaragedoors.com'

// POST — the LOGGED-IN tech accepts their commission plan for a period.
// Body: { period_start, period_end, typed_name, agree }
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { period_start?: string; period_end?: string; typed_name?: string; agree?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const { period_start, period_end, typed_name, agree } = body
  if (!period_start || !period_end) return NextResponse.json({ error: 'period required' }, { status: 400 })
  if (agree !== true) return NextResponse.json({ error: 'You must check the agreement box.' }, { status: 400 })
  if (!typed_name || !typed_name.trim()) return NextResponse.json({ error: 'Type your full name to sign.' }, { status: 400 })

  const period = periodForRecognitionDate(period_start)
  if (!period || period.start !== period_start || period.end !== period_end) {
    return NextResponse.json({ error: 'invalid period' }, { status: 400 })
  }

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )

  const { data: plan } = await db
    .from('commission_plans')
    .select('id, sales_target, rate_below, rate_above, period_start, period_end')
    .eq('tech_user_id', user.id)
    .eq('period_start', period_start)
    .eq('period_end', period_end)
    .maybeSingle()
  if (!plan) return NextResponse.json({ error: 'No commission plan to accept for this period.' }, { status: 404 })

  const terms: PlanTerms = {
    sales_target: Number(plan.sales_target),
    rate_below: Number(plan.rate_below),
    rate_above: Number(plan.rate_above),
    period_start: plan.period_start,
    period_end: plan.period_end,
  }
  const fingerprint = planFingerprint(terms)
  const acceptedName = typed_name.trim()
  const acceptedAtIso = new Date().toISOString()
  const acceptedAtHuman = new Date(acceptedAtIso).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'full', timeStyle: 'long',
  })

  const ip = (req.headers.get('x-forwarded-for')?.split(',')[0].trim())
    || req.headers.get('x-real-ip')
    || null
  const userAgent = req.headers.get('user-agent') || null

  const { error: insErr } = await db.from('commission_plan_acceptances').insert({
    plan_id: plan.id,
    tech_user_id: user.id,
    period_start,
    period_end,
    accepted_by: user.id,
    accepted_name: acceptedName,
    accepted_at: acceptedAtIso,
    ip,
    user_agent: userAgent,
    legal_version: LEGAL_VERSION,
    terms_fingerprint: fingerprint,
    terms_snapshot: {
      sales_target: terms.sales_target,
      rate_below: terms.rate_below,
      rate_above: terms.rate_above,
      period_start: terms.period_start,
      period_end: terms.period_end,
      legal_version: LEGAL_VERSION,
      period_label: fmtPeriodLabel(terms.period_start),
    },
  })
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 })

  // Send the confirmation email (record of what was accepted). Best-effort — the
  // acceptance is already persisted, so a mail hiccup must not fail the request.
  try {
    const { data: authUser } = await db.auth.admin.getUserById(user.id)
    const { data: profile } = await db.from('profiles').select('full_name').eq('id', user.id).maybeSingle()
    const email = authUser?.user?.email
    if (email) {
      const { subject, html, text } = renderCommissionAcceptanceEmail({
        terms,
        techName: profile?.full_name ?? acceptedName,
        acceptedName,
        acceptedAt: acceptedAtHuman,
        legalVersion: LEGAL_VERSION,
        ip,
      })
      await sendEmail({ to: email, subject, html, text, bcc: COMPLIANCE_BCC })
    }
  } catch (e) {
    console.error('[commission] acceptance confirmation email failed:', e)
  }

  return NextResponse.json({ ok: true })
}
