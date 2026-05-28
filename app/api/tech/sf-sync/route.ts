import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getProvider } from '@/lib/crm'
import { getWeekEnd, parseDate } from '@/lib/week'

export const maxDuration = 60

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, is_active, sf_technician_id')
    .eq('id', user.id)
    .single()

  if (!profile?.is_active || profile.role !== 'technician') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!profile.sf_technician_id) {
    return NextResponse.json({ error: 'not_mapped' }, { status: 400 })
  }

  const { week_start } = await req.json()
  if (!week_start) return NextResponse.json({ error: 'week_start required' }, { status: 400 })

  // Block sync on submitted weeks (admin_unlocked = true means it's open again)
  const { data: submission } = await supabase
    .from('week_submissions')
    .select('submitted_at')
    .eq('tech_id', user.id)
    .eq('week_start_date', week_start)
    .maybeSingle()

  if (submission?.submitted_at) {
    return NextResponse.json({ error: 'Week is already submitted' }, { status: 400 })
  }

  const service = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  let added = 0
  let updated = 0
  let errorMessage: string | null = null

  try {
    const provider = getProvider()
    const weekStartDate = parseDate(week_start)
    const weekEndDate = parseDate(getWeekEnd(week_start))

    const sfJobs = await provider.listJobsForTech(
      profile.sf_technician_id as string,
      weekStartDate,
      weekEndDate
    )

    const now = new Date().toISOString()

    for (const sfJob of sfJobs) {
      const { data: existing } = await service
        .from('jobs')
        .select('id')
        .eq('tech_id', user.id)
        .eq('sf_job_id', sfJob.id)
        .maybeSingle()

      if (existing) {
        // Update SF status + number only — never overwrite work items or notes the tech entered
        await service
          .from('jobs')
          .update({ sf_status: sfJob.status, sf_job_number: sfJob.jobNumber, sf_last_synced_at: now })
          .eq('id', existing.id)
        updated++
      } else {
        await service.from('jobs').insert({
          tech_id: user.id,
          work_date: sfJob.scheduledDate,
          job_name: sfJob.customerName,
          notes: null,
          total_pay: 0,
          week_start_date: week_start,
          source: 'service_fusion',
          sf_job_id: sfJob.id,
          sf_job_number: sfJob.jobNumber,
          sf_status: sfJob.status,
          sf_last_synced_at: now,
        })
        added++
      }

      // Refresh stored items for this SF job (delete + re-insert)
      if (sfJob.items.length > 0) {
        await service.from('sf_job_items').delete().eq('sf_job_id', sfJob.id)
        await service.from('sf_job_items').insert(
          sfJob.items.map(item => ({ sf_job_id: sfJob.id, ...item, sf_synced_at: now }))
        )
      }
    }
  } catch (err: unknown) {
    errorMessage = err instanceof Error ? err.message : 'Sync failed'
  }

  await service.from('crm_sync_log').insert({
    tech_id: user.id,
    week_start,
    jobs_added: added,
    jobs_updated: updated,
    success: !errorMessage,
    error_message: errorMessage,
  })

  if (errorMessage) {
    return NextResponse.json({ error: errorMessage }, { status: 502 })
  }
  return NextResponse.json({ added, updated })
}
