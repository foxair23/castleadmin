import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { periodForRecognitionDate } from '@/lib/commission/periods'

// GET ?period_start=&period_end= — reviews leaderboard for the period.
// Per-tech review counts + star breakdown, ranked by total. Visible to all
// authenticated users (techs + admins). Reviews are attributed to techs via the
// matched job's assigned techs (sf_job_techs).
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

  const { data: reviews } = await db
    .from('google_reviews')
    .select('matched_job_id, matched_tech_user_id, star_rating')
    .in('match_status', ['auto', 'confirmed'])
    .is('deleted_at', null)
    .not('matched_job_id', 'is', null)
    .gte('created_at_google', `${start}T00:00:00`)
    .lte('created_at_google', `${end}T23:59:59.999`)

  const list = (reviews ?? []) as Array<{ matched_job_id: string; matched_tech_user_id: string | null; star_rating: number }>

  type Row = { techName: string; total: number; avg: number; s5: number; s4: number; s3: number; s2: number; s1: number }
  const byTech: Record<string, Row & { _sum: number }> = {}
  function credit(name: string, stars: number) {
    if (!name) return
    if (!byTech[name]) byTech[name] = { techName: name, total: 0, avg: 0, s5: 0, s4: 0, s3: 0, s2: 0, s1: 0, _sum: 0 }
    const t = byTech[name]
    t.total++
    t._sum += stars
    if (stars === 5) t.s5++
    else if (stars === 4) t.s4++
    else if (stars === 3) t.s3++
    else if (stars === 2) t.s2++
    else if (stars === 1) t.s1++
  }

  // Reviews with an admin tech override are credited solely to that tech. The
  // rest fall back to the matched job's assigned techs (sf_job_techs).
  const overridden = list.filter(r => r.matched_tech_user_id)
  const jobDerived = list.filter(r => !r.matched_tech_user_id)

  const overrideIds = [...new Set(overridden.map(r => r.matched_tech_user_id as string))]
  if (overrideIds.length > 0) {
    const { data: techs } = await db
      .from('profiles')
      .select('id, full_name')
      .in('id', overrideIds)
    const nameById: Record<string, string> = {}
    for (const t of (techs ?? []) as Array<{ id: string; full_name: string | null }>) {
      if (t.full_name) nameById[t.id] = t.full_name
    }
    for (const r of overridden) {
      const name = nameById[r.matched_tech_user_id as string]
      if (name) credit(name, r.star_rating)
    }
  }

  const jobIds = [...new Set(jobDerived.map(r => r.matched_job_id))]
  if (jobIds.length > 0) {
    const { data: jobTechs } = await db
      .from('sf_job_techs')
      .select('job_id, tech_first_name, tech_last_name')
      .in('job_id', jobIds)

    const techsByJob: Record<string, string[]> = {}
    for (const jt of (jobTechs ?? []) as Array<{ job_id: string; tech_first_name: string | null; tech_last_name: string | null }>) {
      const name = [jt.tech_first_name, jt.tech_last_name].filter(Boolean).join(' ')
      if (!name) continue
      ;(techsByJob[jt.job_id] ??= []).push(name)
    }

    for (const r of jobDerived) {
      for (const name of new Set(techsByJob[r.matched_job_id] ?? [])) {
        credit(name, r.star_rating)
      }
    }
  }

  const rows = Object.values(byTech)
    .map(({ _sum, ...r }) => ({ ...r, avg: r.total > 0 ? Math.round((_sum / r.total) * 10) / 10 : 0 }))
    .sort((a, b) => b.total - a.total || a.techName.localeCompare(b.techName))

  return NextResponse.json({ rows })
}
