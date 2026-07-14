import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

function admin() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await admin()
    .from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') return null
  return user
}

// Jobs for a given customer, most recent first, each with the tech(s) who
// worked it. Used by the reviews admin to manually assign a review to a
// specific job — the review's credited tech is derived from that job.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!await requireAdmin()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const db = admin()

  const { data: jobs, error } = await db
    .from('sf_jobs')
    .select('id, number, status, closed_at, start_date, total, customer_name')
    .eq('customer_id', id)
    .eq('is_deleted', false)
    .order('closed_at', { ascending: false, nullsFirst: false })
    .order('start_date', { ascending: false, nullsFirst: false })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const jobRows = (jobs ?? []) as Array<{
    id: string; number: string | null; status: string | null
    closed_at: string | null; start_date: string | null
    total: number | null; customer_name: string | null
  }>

  const jobTechMap: Record<string, string> = {}
  if (jobRows.length > 0) {
    const { data: jobTechs } = await db
      .from('sf_job_techs')
      .select('job_id, tech_first_name, tech_last_name')
      .in('job_id', jobRows.map(j => j.id))
    const byJob: Record<string, string[]> = {}
    for (const jt of (jobTechs ?? []) as Array<{ job_id: string; tech_first_name: string | null; tech_last_name: string | null }>) {
      const name = [jt.tech_first_name, jt.tech_last_name].filter(Boolean).join(' ')
      if (!name) continue
      ;(byJob[jt.job_id] ??= []).push(name)
    }
    for (const [jobId, names] of Object.entries(byJob)) {
      jobTechMap[jobId] = [...new Set(names)].join(', ')
    }
  }

  const result = jobRows.map(j => ({
    id: j.id,
    number: j.number,
    status: j.status,
    date: j.closed_at ?? j.start_date ?? null,
    total: j.total,
    tech_name: jobTechMap[j.id] ?? null,
  }))

  return NextResponse.json({ jobs: result })
}
