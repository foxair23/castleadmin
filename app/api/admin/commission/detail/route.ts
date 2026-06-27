import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { requireCommissionAdmin } from '@/lib/commission/admin-auth'
import { computeTechPeriodDetail } from '@/lib/commission/detail'
import { periodForRecognitionDate } from '@/lib/commission/periods'

// GET ?tech_user_id=&period_start=&period_end= — commission detail for any tech
// (admin all-tech view, §8.1).
export async function GET(req: NextRequest) {
  const admin = await requireCommissionAdmin()
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const p = req.nextUrl.searchParams
  const techUserId = p.get('tech_user_id')
  const start = p.get('period_start')
  const end = p.get('period_end')
  if (!techUserId || !start || !end) {
    return NextResponse.json({ error: 'tech_user_id and period required' }, { status: 400 })
  }

  const period = periodForRecognitionDate(start)
  if (!period || period.start !== start || period.end !== end) {
    return NextResponse.json({ error: 'invalid period' }, { status: 400 })
  }

  const db = await createServiceClient()
  const detail = await computeTechPeriodDetail(db, techUserId, period)
  return NextResponse.json(detail)
}
