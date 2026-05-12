import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

export const maxDuration = 60

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: p } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (p?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const nameFilter = req.nextUrl.searchParams.get('name') ?? 'Juan'
  const weekStart = req.nextUrl.searchParams.get('weekStart') // optional YYYY-MM-DD

  let weekEnd: string | null = null
  if (weekStart && /^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    const d = new Date(weekStart + 'T00:00:00')
    d.setDate(d.getDate() + 6)
    weekEnd = d.toISOString().slice(0, 10)
  }

  const { data: matchedProfiles } = await db
    .from('profiles')
    .select('id, full_name, sf_technician_id, role')
    .ilike('full_name', `%${nameFilter}%`)

  const results = await Promise.all((matchedProfiles ?? []).map(async profile => {
    const sfId = profile.sf_technician_id ?? '__none__'

    const { count: sfAssignmentsTotal } = await db
      .from('sf_job_techs_cache')
      .select('id', { count: 'exact', head: true })
      .eq('sf_tech_id', sfId)

    const { count: pwJobs } = await db
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('tech_id', profile.id)

    const { count: pwJobsLinked } = await db
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('tech_id', profile.id)
      .not('sf_job_id', 'is', null)

    let weekData = null
    if (weekStart && weekEnd) {
      // SF jobs closed this week assigned to this tech
      const { data: weekJobs } = await db
        .from('sf_jobs_cache')
        .select('id, is_closed, completed_at, total_amount, status_name')
        .gte('completed_at', weekStart + 'T00:00:00')
        .lte('completed_at', weekEnd + 'T23:59:59')
        .not('completed_at', 'is', null)

      const weekJobIds = (weekJobs ?? []).map(j => j.id as string)

      let assignedJobIds: string[] = []
      if (weekJobIds.length > 0) {
        const { data: assignments } = await db
          .from('sf_job_techs_cache')
          .select('sf_job_id')
          .eq('sf_tech_id', sfId)
          .in('sf_job_id', weekJobIds)
        assignedJobIds = (assignments ?? []).map(a => a.sf_job_id as string)
      }

      const assignedJobs = (weekJobs ?? []).filter(j => assignedJobIds.includes(j.id as string))
      const closedAssigned = assignedJobs.filter(j => j.is_closed)
      const openAssigned = assignedJobs.filter(j => !j.is_closed)

      // Sample a few jobs to check status names
      const { data: sampleJobs } = await db
        .from('sf_jobs_cache')
        .select('id, is_closed, completed_at, status_name, total_amount')
        .gte('completed_at', weekStart + 'T00:00:00')
        .lte('completed_at', weekEnd + 'T23:59:59')
        .not('completed_at', 'is', null)
        .in('id', assignedJobIds.slice(0, 10))

      weekData = {
        weekStart,
        weekEnd,
        sfJobsInWeekTotal: weekJobs?.length ?? 0,
        assignedToTech: assignedJobs.length,
        closedAndAssigned: closedAssigned.length,
        openButAssigned: openAssigned.length,
        sampleJobs: sampleJobs ?? [],
      }
    }

    return {
      name: profile.full_name,
      role: profile.role,
      sfTechnicianId: profile.sf_technician_id,
      sfAssignmentsTotal,
      pieceworkJobsTotal: pwJobs,
      pieceworkJobsLinkedToSF: pwJobsLinked,
      weekData,
    }
  }))

  return NextResponse.json({ nameFilter, weekStart, results })
}
