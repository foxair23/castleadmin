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

  const nameFilter = req.nextUrl.searchParams.get('name') ?? 'David'

  const { data: matchedProfiles } = await db
    .from('profiles')
    .select('id, full_name, sf_technician_id, role')
    .ilike('full_name', `%${nameFilter}%`)

  const results = await Promise.all((matchedProfiles ?? []).map(async profile => {
    const sfId = profile.sf_technician_id ?? '__none__'

    const { count: sfAssignments } = await db
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

    return {
      name: profile.full_name,
      role: profile.role,
      sfTechnicianId: profile.sf_technician_id,
      sfAssignmentsInCache: sfAssignments,
      pieceworkJobsTotal: pwJobs,
      pieceworkJobsLinkedToSF: pwJobsLinked,
    }
  }))

  return NextResponse.json({ nameFilter, results })
}
