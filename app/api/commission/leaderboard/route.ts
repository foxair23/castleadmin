import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient, type SupabaseClient } from '@supabase/supabase-js'
import { periodForRecognitionDate } from '@/lib/commission/periods'

// GET ?period_start=&period_end= — team leaderboard.
//
// Uses the SAME calculation as the Commission (Technicians) tab: the engine's
// commission_job_eligibility rows, credited by recognition date (the month the
// job was COMPLETED). The two screens therefore tie to the penny:
//   completed_revenue = sum of eligible job revenue completed in the period
//                       (= the tab's Completed + Invoiced + Payment Received)
//   received_revenue  = the portion collected (revenue_frozen — the tab's
//                       Payment Received chevron)
// Denied and needs-review jobs are excluded exactly as on the tab. Rates,
// targets, and commission amounts are never returned — revenue only.
//
// Visible to all authenticated users.

async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const PAGE = 1000
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1)
    if (error) throw new Error(JSON.stringify(error))
    if (!data || data.length === 0) break
    out.push(...data)
    if (data.length < PAGE) break
  }
  return out
}

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

  const db: SupabaseClient = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )

  const elig = await fetchAll<{ tech_user_id: string; revenue: number | null; revenue_frozen: boolean }>((f, t) =>
    db.from('commission_job_eligibility')
      .select('tech_user_id, revenue, revenue_frozen, id')
      .eq('status', 'eligible')
      .not('tech_user_id', 'is', null)
      .gte('recognition_date', start)
      .lte('recognition_date', end)
      .order('id', { ascending: true })
      .range(f, t),
  )

  const byTech = new Map<string, { completed: number; received: number }>()
  for (const e of elig) {
    const cur = byTech.get(e.tech_user_id) ?? { completed: 0, received: 0 }
    cur.completed += e.revenue ?? 0
    if (e.revenue_frozen) cur.received += e.revenue ?? 0
    byTech.set(e.tech_user_id, cur)
  }

  const techIds = Array.from(byTech.keys())
  const names = new Map<string, string>()
  if (techIds.length > 0) {
    const { data: profiles } = await db.from('profiles').select('id, full_name').in('id', techIds)
    for (const p of profiles ?? []) names.set(p.id, p.full_name)
  }

  const rows = techIds
    .map(id => ({
      tech_name: names.get(id) ?? 'Unknown',
      completed_revenue: Math.round(byTech.get(id)!.completed * 100) / 100,
      received_revenue: Math.round(byTech.get(id)!.received * 100) / 100,
    }))
    .sort((a, b) => b.completed_revenue - a.completed_revenue)
    .map((row, i) => ({ rank: i + 1, ...row }))

  return NextResponse.json({ rows })
}
