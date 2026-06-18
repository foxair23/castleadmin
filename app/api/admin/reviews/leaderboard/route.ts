import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return null
  return user
}

function getMondayUTC(date: Date): Date {
  const d = new Date(date)
  const day = d.getUTCDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setUTCDate(d.getUTCDate() + diff)
  d.setUTCHours(0, 0, 0, 0)
  return d
}

// GET /api/admin/reviews/leaderboard?weekStart=2026-06-16
// Returns per-tech review counts + star breakdown for the given Mon–Sun week.
// weekStart defaults to the current Monday (UTC).
export async function GET(req: NextRequest) {
  if (!await requireAdmin()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const weekStartParam = new URL(req.url).searchParams.get('weekStart')
  const weekStart = getMondayUTC(weekStartParam ? new Date(weekStartParam + 'T00:00:00Z') : new Date())
  const weekEnd   = new Date(weekStart)
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7)

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  const { data: reviews, error } = await db
    .from('google_reviews')
    .select('matched_job_id, star_rating')
    .in('match_status', ['auto', 'confirmed'])
    .is('deleted_at', null)
    .not('matched_job_id', 'is', null)
    .gte('created_at_google', weekStart.toISOString())
    .lt('created_at_google', weekEnd.toISOString())

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const jobIds = [...new Set(
    (reviews ?? []).map((r: { matched_job_id: string }) => r.matched_job_id)
  )]

  type TechRow = { techName: string; total: number; s5: number; s4: number; s3: number; s2: number; s1: number }
  const techMap: Record<string, TechRow> = {}

  if (jobIds.length > 0) {
    const { data: jobTechs } = await db
      .from('sf_job_techs')
      .select('job_id, tech_first_name, tech_last_name')
      .in('job_id', jobIds)

    const starByJob: Record<string, number> = {}
    for (const r of (reviews ?? []) as Array<{ matched_job_id: string; star_rating: number }>) {
      starByJob[r.matched_job_id] = r.star_rating
    }

    for (const jt of (jobTechs ?? []) as Array<{ job_id: string; tech_first_name: string | null; tech_last_name: string | null }>) {
      const name = [jt.tech_first_name, jt.tech_last_name].filter(Boolean).join(' ')
      if (!name) continue
      const stars = starByJob[jt.job_id]
      if (stars == null) continue
      if (!techMap[name]) techMap[name] = { techName: name, total: 0, s5: 0, s4: 0, s3: 0, s2: 0, s1: 0 }
      techMap[name].total++
      if      (stars === 5) techMap[name].s5++
      else if (stars === 4) techMap[name].s4++
      else if (stars === 3) techMap[name].s3++
      else if (stars === 2) techMap[name].s2++
      else if (stars === 1) techMap[name].s1++
    }
  }

  const rows = Object.values(techMap)
    .sort((a, b) => b.total - a.total || a.techName.localeCompare(b.techName))

  return NextResponse.json({
    weekStart: weekStart.toISOString().slice(0, 10),
    weekEnd:   new Date(weekEnd.getTime() - 86400000).toISOString().slice(0, 10), // inclusive Sunday
    rows,
  })
}
