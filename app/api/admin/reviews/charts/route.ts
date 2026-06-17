import { NextResponse } from 'next/server'
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

export async function GET() {
  if (!await requireAdmin()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  // Monthly trend — last 18 months
  const { data: monthlyRaw } = await db.rpc('google_reviews_monthly_trend')

  // Tech leaderboard — via matched_job_id → sf_job_techs
  const { data: reviews } = await db
    .from('google_reviews')
    .select('matched_job_id, star_rating')
    .in('match_status', ['auto', 'confirmed'])
    .is('deleted_at', null)
    .not('matched_job_id', 'is', null)

  const jobIds = [...new Set((reviews ?? []).map((r: { matched_job_id: string }) => r.matched_job_id))]

  const techMap: Record<string, { name: string; count: number; totalStars: number }> = {}

  if (jobIds.length > 0) {
    const { data: jobTechs } = await db
      .from('sf_job_techs')
      .select('job_id, tech_first_name, tech_last_name')
      .in('job_id', jobIds)

    const reviewByJob: Record<string, number> = {}
    for (const r of (reviews ?? []) as Array<{ matched_job_id: string; star_rating: number }>) {
      reviewByJob[r.matched_job_id] = r.star_rating
    }

    for (const jt of (jobTechs ?? []) as Array<{ job_id: string; tech_first_name: string | null; tech_last_name: string | null }>) {
      const name = [jt.tech_first_name, jt.tech_last_name].filter(Boolean).join(' ')
      if (!name) continue
      const stars = reviewByJob[jt.job_id]
      if (stars == null) continue
      if (!techMap[name]) techMap[name] = { name, count: 0, totalStars: 0 }
      techMap[name].count++
      techMap[name].totalStars += stars
    }
  }

  const techLeaderboard = Object.values(techMap)
    .map(t => ({ name: t.name, reviews: t.count, avgRating: Math.round((t.totalStars / t.count) * 10) / 10 }))
    .sort((a, b) => b.reviews - a.reviews)
    .slice(0, 15)

  return NextResponse.json({ monthly: monthlyRaw ?? [], techLeaderboard })
}
