import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { periodForRecognitionDate } from '@/lib/commission/periods'
import { getUpsellForPeriod } from '@/lib/commission/upsell'

// Upsell tab data for a commission period. Admin-only — the baseline/upsell
// figures are internal and must not be exposed to techs.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
  const { data: profile } = await db.from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const start = req.nextUrl.searchParams.get('period_start')
  const end = req.nextUrl.searchParams.get('period_end')
  if (!start || !end) return NextResponse.json({ error: 'period required' }, { status: 400 })
  const period = periodForRecognitionDate(start)
  if (!period || period.start !== start || period.end !== end) {
    return NextResponse.json({ error: 'invalid period' }, { status: 400 })
  }

  const result = await getUpsellForPeriod(period)
  return NextResponse.json(result)
}
