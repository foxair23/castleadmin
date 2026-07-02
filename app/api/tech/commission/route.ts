import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { computeTechPeriodDetail } from '@/lib/commission/detail'
import { periodForRecognitionDate } from '@/lib/commission/periods'
import { planFingerprint, buildTokens, renderLegalHtml, renderTermsSummaryHtml, type PlanTerms } from '@/lib/commission/acceptance'
import { LEGAL_VERSION } from '@/lib/commission/legal-agreement'

// GET ?period_start=&period_end= — commission detail for the LOGGED-IN tech
// only. The tech id is taken from the session, never the request, so a tech
// can never read another tech's detail.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const start = req.nextUrl.searchParams.get('period_start')
  const end = req.nextUrl.searchParams.get('period_end')
  if (!start || !end) return NextResponse.json({ error: 'period required' }, { status: 400 })

  // Reconstruct the period label from its start date.
  const period = periodForRecognitionDate(start)
  if (!period || period.start !== start || period.end !== end) {
    return NextResponse.json({ error: 'invalid period' }, { status: 400 })
  }

  // Use a TRUE service-role client (no user session) so the full detail is
  // computed server-side regardless of RLS — the tech is authorized above and
  // only ever sees their own id's derived result, never raw plan/rate rows.
  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
  // Gate: if this period has a plan the tech hasn't accepted (or that was edited
  // since acceptance), return the acceptance requirement INSTEAD of the figures —
  // the commission numbers are never sent to the client until accepted.
  const { data: plan } = await db
    .from('commission_plans')
    .select('id, sales_target, rate_below, rate_above, period_start, period_end')
    .eq('tech_user_id', user.id)
    .eq('period_start', start)
    .eq('period_end', end)
    .maybeSingle()

  if (plan) {
    const terms: PlanTerms = {
      sales_target: Number(plan.sales_target),
      rate_below: Number(plan.rate_below),
      rate_above: Number(plan.rate_above),
      period_start: plan.period_start,
      period_end: plan.period_end,
    }
    const fp = planFingerprint(terms)
    const { data: acc } = await db
      .from('commission_plan_acceptances')
      .select('terms_fingerprint')
      .eq('plan_id', plan.id)
      .order('accepted_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (acc?.terms_fingerprint !== fp) {
      const { data: profile } = await db.from('profiles').select('full_name').eq('id', user.id).maybeSingle()
      const tokens = buildTokens(terms, profile?.full_name ?? '')
      return NextResponse.json({
        needsAcceptance: true,
        period: { start, end, label: period.label },
        legalVersion: LEGAL_VERSION,
        termsSummaryHtml: renderTermsSummaryHtml(terms, tokens),
        legalHtml: renderLegalHtml(tokens),
      })
    }
  }

  const detail = await computeTechPeriodDetail(db, user.id, period)
  return NextResponse.json(detail)
}
