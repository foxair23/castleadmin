import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getProvider } from '@/lib/crm'
import { getWeekEnd, parseDate } from '@/lib/week'

export const maxDuration = 60

function adminDb() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: p } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (p?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    const body = await req.json().catch(() => ({}))
    const weekStart = body?.weekStart as string
    if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      return NextResponse.json({ error: 'weekStart required (YYYY-MM-DD)' }, { status: 400 })
    }

    const weekEnd = getWeekEnd(weekStart)
    const weekStartDate = parseDate(weekStart)
    const weekEndDate = parseDate(weekEnd)

    const db = adminDb()
    const provider = getProvider()
    const now = new Date().toISOString()

    // Load all active techs with SF mapping
    const { data: profiles } = await db
      .from('profiles')
      .select('id, full_name, sf_technician_id')
      .eq('role', 'technician')
      .eq('is_active', true)
      .not('sf_technician_id', 'is', null)

    if (!profiles?.length) {
      return NextResponse.json({ error: 'No mapped technicians found' }, { status: 400 })
    }

    // Fetch all techs' SF jobs in parallel
    const techResults = await Promise.all(
      profiles.map(async profile => {
        try {
          const sfJobs = await provider.listJobsForTech(
            profile.sf_technician_id as string,
            weekStartDate,
            weekEndDate
          )
          return { profile, sfJobs }
        } catch {
          return { profile, sfJobs: [] }
        }
      })
    )

    // Bulk-check which (tech_id, sf_job_id, work_date) triples already exist
    const allTriples = techResults.flatMap(({ profile, sfJobs }) =>
      sfJobs.map(j => ({ techId: profile.id, sfJobId: j.id, workDate: j.scheduledDate }))
    )

    const allSfJobIds = [...new Set(allTriples.map(t => t.sfJobId))]
    const existingSet = new Set<string>()

    if (allSfJobIds.length > 0) {
      const { data: existing } = await db
        .from('jobs')
        .select('tech_id, sf_job_id, work_date')
        .in('sf_job_id', allSfJobIds)
        .not('sf_job_id', 'is', null)
      for (const row of existing ?? []) {
        existingSet.add(`${row.tech_id}::${row.sf_job_id}::${row.work_date}`)
      }
    }

    let added = 0
    let updated = 0

    for (const { profile, sfJobs } of techResults) {
      const refreshedJobIds = new Set<string>()

      for (const sfJob of sfJobs) {
        const key = `${profile.id}::${sfJob.id}::${sfJob.scheduledDate}`
        if (existingSet.has(key)) {
          await db
            .from('jobs')
            .update({
              sf_status: sfJob.status,
              sf_job_number: sfJob.jobNumber,
              sf_last_synced_at: now,
              sf_visit_index: sfJob.visitIndex,
              sf_visit_total: sfJob.visitTotal,
            })
            .eq('tech_id', profile.id)
            .eq('sf_job_id', sfJob.id)
            .eq('work_date', sfJob.scheduledDate)
          updated++
        } else {
          await db.from('jobs').insert({
            tech_id: profile.id,
            work_date: sfJob.scheduledDate,
            job_name: sfJob.customerName,
            notes: null,
            total_pay: 0,
            week_start_date: weekStart,
            source: 'service_fusion',
            sf_job_id: sfJob.id,
            sf_job_number: sfJob.jobNumber,
            sf_status: sfJob.status,
            sf_last_synced_at: now,
            sf_visit_index: sfJob.visitIndex,
            sf_visit_total: sfJob.visitTotal,
          })
          added++
        }

        // Refresh stored items once per SF job (same items across all visits)
        if (!refreshedJobIds.has(sfJob.id)) {
          refreshedJobIds.add(sfJob.id)
          await db.from('sf_job_items').delete().eq('sf_job_id', sfJob.id)
        }
      }
    }

    return NextResponse.json({ ok: true, weekStart, techCount: profiles.length, added, updated })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
