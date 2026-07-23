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

export async function GET(req: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const page     = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))
  const pageSize = 25
  const stars    = searchParams.get('stars')
  const status   = searchParams.get('status')
  const dateFrom = searchParams.get('date_from')
  const dateTo   = searchParams.get('date_to')

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  let query = db
    .from('google_reviews')
    .select(
      'id, google_review_id, reviewer_name, star_rating, comment, created_at_google, reply_text, match_status, match_score, match_confidence, matched_customer_id, matched_job_id, matched_tech_user_id, deleted_at',
      { count: 'exact' }
    )
    .is('deleted_at', null)
    .order('created_at_google', { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1)

  if (stars) {
    const ratings = stars.split(',').map(s => parseInt(s, 10)).filter(n => n >= 1 && n <= 5)
    if (ratings.length > 0) query = query.in('star_rating', ratings)
  }
  if (status && status !== 'all') query = query.eq('match_status', status)
  if (dateFrom) query = query.gte('created_at_google', dateFrom)
  if (dateTo)   query = query.lte('created_at_google', dateTo + 'T23:59:59Z')

  const { data, error, count } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = (data ?? []) as Array<Record<string, unknown> & { matched_customer_id: string | null; matched_job_id: string | null; matched_tech_user_id: string | null }>

  // Resolve admin tech overrides to display names. When a review has a pinned
  // tech, it wins over the job-derived tech below.
  const overrideIds = [...new Set(
    rows.map(r => r.matched_tech_user_id).filter((id): id is string => id != null)
  )]
  const overrideTechMap: Record<string, string> = {}
  if (overrideIds.length > 0) {
    const { data: techs } = await db
      .from('profiles')
      .select('id, full_name')
      .in('id', overrideIds)
    for (const t of (techs ?? []) as Array<{ id: string; full_name: string | null }>) {
      if (t.full_name) overrideTechMap[t.id] = t.full_name
    }
  }

  const customerIds = [...new Set(
    rows.map(r => r.matched_customer_id).filter((id): id is string => id != null)
  )]
  const customerNameMap: Record<string, string> = {}
  if (customerIds.length > 0) {
    const { data: customers } = await db
      .from('sf_customers')
      .select('id, customer_name')
      .in('id', customerIds)
    for (const c of (customers ?? []) as Array<{ id: string; customer_name: string | null }>) {
      if (c.customer_name) customerNameMap[c.id] = c.customer_name
    }
  }

  // Tech(s) who worked the matched job, via sf_job_techs. Also pull the job's
  // own customer_name as a fallback display name — sf_customers is an incomplete
  // cache, so many matched customers aren't in it and customerNameMap misses.
  const jobIds = [...new Set(
    rows.map(r => r.matched_job_id).filter((id): id is string => id != null)
  )]
  const jobTechMap: Record<string, string> = {}
  const jobCustomerNameMap: Record<string, string> = {}
  if (jobIds.length > 0) {
    const { data: jobTechs } = await db
      .from('sf_job_techs')
      .select('job_id, tech_first_name, tech_last_name')
      .in('job_id', jobIds)
    const byJob: Record<string, string[]> = {}
    for (const jt of (jobTechs ?? []) as Array<{ job_id: string; tech_first_name: string | null; tech_last_name: string | null }>) {
      const name = [jt.tech_first_name, jt.tech_last_name].filter(Boolean).join(' ')
      if (!name) continue
      ;(byJob[jt.job_id] ??= []).push(name)
    }
    for (const [jobId, names] of Object.entries(byJob)) {
      jobTechMap[jobId] = [...new Set(names)].join(', ')
    }

    const { data: jobRows } = await db
      .from('sf_jobs')
      .select('id, customer_name')
      .in('id', jobIds)
    for (const j of (jobRows ?? []) as Array<{ id: string; customer_name: string | null }>) {
      if (j.customer_name) jobCustomerNameMap[j.id] = j.customer_name
    }
  }

  const reviews = rows.map(r => ({
    ...r,
    matched_customer_name:
      (r.matched_customer_id ? customerNameMap[r.matched_customer_id] : null) ??
      (r.matched_job_id ? jobCustomerNameMap[r.matched_job_id] : null) ??
      null,
    matched_tech_name:
      (r.matched_tech_user_id ? overrideTechMap[r.matched_tech_user_id] : null) ??
      (r.matched_job_id ? jobTechMap[r.matched_job_id] : null) ??
      null,
    matched_tech_overridden: r.matched_tech_user_id != null,
  }))

  return NextResponse.json({ reviews, total: count ?? 0, page, pageSize })
}
