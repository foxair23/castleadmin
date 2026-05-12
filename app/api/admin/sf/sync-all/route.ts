import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getProvider } from '@/lib/crm'
import { getWeekStart, getWeekEnd, parseDate, formatDate } from '@/lib/week'

export const maxDuration = 60

function adminDb() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

function getPastWeekStarts(count: number): string[] {
  const weeks: string[] = []
  const d = parseDate(getWeekStart())
  for (let i = 0; i < count; i++) {
    weeks.push(formatDate(d))
    d.setDate(d.getDate() - 7)
  }
  return weeks
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: p } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (p?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  const weeks = Math.min(12, Math.max(1, Number(body?.weeks ?? 4) || 4))

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

  const weekStarts = getPastWeekStarts(weeks)
  const summary: Record<string, { added: number; updated: number }> = {}

  for (const profile of profiles) {
    summary[profile.full_name] = { added: 0, updated: 0 }

    for (const weekStart of weekStarts) {
      const weekEnd = getWeekEnd(weekStart)
      const weekStartDate = parseDate(weekStart)
      const weekEndDate = parseDate(weekEnd)

      let sfJobs
      try {
        sfJobs = await provider.listJobsForTech(
          profile.sf_technician_id as string,
          weekStartDate,
          weekEndDate
        )
      } catch {
        // SF API error for this tech/week — skip and continue
        continue
      }

      for (const sfJob of sfJobs) {
        const { data: existing } = await db
          .from('jobs')
          .select('id')
          .eq('tech_id', profile.id)
          .eq('sf_job_id', sfJob.id)
          .maybeSingle()

        if (existing) {
          await db
            .from('jobs')
            .update({ sf_status: sfJob.status, sf_job_number: sfJob.jobNumber, sf_last_synced_at: now })
            .eq('id', existing.id)
          summary[profile.full_name].updated++
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
          })
          summary[profile.full_name].added++
        }
      }
    }
  }

  return NextResponse.json({ ok: true, weeks, techCount: profiles.length, summary })
}
