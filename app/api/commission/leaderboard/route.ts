import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { periodForRecognitionDate } from '@/lib/commission/periods'

// GET ?period_start=&period_end= — sales leaderboard (TRD §9). Visible to ALL
// authenticated users (techs + admins). Ranks techs by dollars sold (eligible
// recognized revenue) and shows dollars received (collected). Exposes NOTHING
// else — no rates, targets, or commission earnings. Aggregated server-side with
// a service-role client so per-job/tech detail is never sent to the client.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const start = req.nextUrl.searchParams.get('period_start')
  const end = req.nextUrl.searchParams.get('period_end')
  if (!start || !end) return NextResponse.json({ error: 'period required' }, { status: 400 })
  const period = periodForRecognitionDate(start)
  if (!period || period.start !== start || period.end !== end) {
    return NextResponse.json({ error: 'invalid period' }, { status: 400 })
  }

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )

  // Eligible jobs recognized in the period, per tech. (Job revenue only — not
  // commission, and not manual adjustments.)
  const { data: rows } = await db
    .from('commission_job_eligibility')
    .select('tech_user_id, revenue, revenue_frozen')
    .eq('status', 'eligible')
    .not('tech_user_id', 'is', null)
    .gte('recognition_date', start)
    .lte('recognition_date', end)

  const byTech = new Map<string, { sold: number; received: number }>()
  for (const r of rows ?? []) {
    const cur = byTech.get(r.tech_user_id!) ?? { sold: 0, received: 0 }
    cur.sold += r.revenue ?? 0
    if (r.revenue_frozen) cur.received += r.revenue ?? 0
    byTech.set(r.tech_user_id!, cur)
  }

  const techIds = Array.from(byTech.keys())
  const names = new Map<string, string>()
  if (techIds.length > 0) {
    const { data: profiles } = await db.from('profiles').select('id, full_name').in('id', techIds)
    for (const p of profiles ?? []) names.set(p.id, p.full_name)
  }

  const ranked = techIds
    .map(id => ({
      tech_name: names.get(id) ?? 'Unknown',
      dollars_sold: Math.round((byTech.get(id)!.sold) * 100) / 100,
      dollars_received: Math.round((byTech.get(id)!.received) * 100) / 100,
    }))
    .sort((a, b) => b.dollars_sold - a.dollars_sold)
    .map((row, i) => ({ rank: i + 1, ...row }))

  return NextResponse.json({ rows: ranked })
}
