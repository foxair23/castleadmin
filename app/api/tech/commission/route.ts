import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
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

  const db = await createServiceClient()
  const detail = await computeTechPeriodDetail(db, user.id, period)
  return NextResponse.json(detail)
}
