import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { computeTechPeriodDetail } from '@/lib/commission/detail'
import { periodForRecognitionDate } from '@/lib/commission/periods'

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
  const detail = await computeTechPeriodDetail(db, user.id, period)
  return NextResponse.json(detail)
}
