import { redirect, notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import Link from 'next/link'
import TechDetailClient from './TechDetailClient'

function adminDb() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

function weekEnd(weekStart: string): string {
  const d = new Date(weekStart + 'T00:00:00')
  d.setDate(d.getDate() + 6)
  return d.toISOString().slice(0, 10)
}

export default async function TechDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ techId: string }>
  searchParams: Promise<{ weekStart?: string }>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') redirect('/admin')

  const { techId } = await params
  const { weekStart } = await searchParams

  if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    redirect('/admin/dashboard')
  }

  const db = adminDb()
  const wkEnd = weekEnd(weekStart)

  // Look up profile by sf_technician_id
  const { data: techProfile } = await db
    .from('profiles')
    .select('id, full_name, sf_technician_id')
    .eq('sf_technician_id', techId)
    .maybeSingle()

  // Fetch SF jobs assigned to this tech in the week
  const { data: allAssignments } = await db
    .from('sf_job_techs_cache')
    .select('sf_job_id')
    .eq('sf_tech_id', techId)

  const assignedJobIds = (allAssignments ?? []).map(a => a.sf_job_id as string)

  let sfJobs: { id: string; total_amount: number | null; completed_at: string | null }[] = []
  if (assignedJobIds.length > 0) {
    const { data } = await db
      .from('sf_jobs_cache')
      .select('id, total_amount, completed_at')
      .in('id', assignedJobIds)
      .eq('is_closed', true)
      .gte('completed_at', weekStart + 'T00:00:00')
      .lte('completed_at', wkEnd + 'T23:59:59')
      .not('completed_at', 'is', null)
      .order('completed_at', { ascending: true })
    sfJobs = (data ?? []) as typeof sfJobs
  }

  // Fetch piecework jobs for this tech+week (if profile is linked)
  type PieceworkJob = {
    id: string
    job_name: string
    work_date: string
    total_pay: number
    items: { name: string; quantity: number; calculated_pay: number }[]
  }
  let pieceworkJobs: PieceworkJob[] = []

  if (techProfile?.id) {
    const { data: pwJobs } = await db
      .from('jobs')
      .select('id, job_name, work_date, total_pay')
      .eq('tech_id', techProfile.id)
      .eq('week_start_date', weekStart)
      .order('work_date', { ascending: true })

    if (pwJobs && pwJobs.length > 0) {
      const jobIds = pwJobs.map(j => j.id as string)
      const { data: items } = await db
        .from('job_work_items')
        .select('job_id, quantity, calculated_pay, job_types(name)')
        .in('job_id', jobIds)

      const itemsByJob: Record<string, PieceworkJob['items']> = {}
      for (const item of items ?? []) {
        const jid = item.job_id as string
        if (!itemsByJob[jid]) itemsByJob[jid] = []
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const typeName = (item.job_types as any)?.name ?? 'Unknown'
        itemsByJob[jid].push({
          name: typeName,
          quantity: item.quantity as number,
          calculated_pay: item.calculated_pay as number,
        })
      }

      pieceworkJobs = pwJobs.map(j => ({
        id: j.id as string,
        job_name: j.job_name as string,
        work_date: j.work_date as string,
        total_pay: j.total_pay as number,
        items: itemsByJob[j.id as string] ?? [],
      }))
    }
  }

  const techName = techProfile?.full_name ?? `Tech ${techId}`
  const totalRevenue = sfJobs.reduce((s, j) => s + (j.total_amount ?? 0), 0)
  const totalLabor = pieceworkJobs.reduce((s, j) => s + j.total_pay, 0)
  const hasPiecework = pieceworkJobs.length > 0

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        <div className="flex items-center gap-3">
          <Link
            href="/admin/dashboard"
            className="text-sm text-gray-500 hover:text-gray-700 font-medium"
          >
            ← Dashboard
          </Link>
        </div>

        <TechDetailClient
          techId={techId}
          techName={techName}
          weekStart={weekStart}
          weekEnd={wkEnd}
          sfJobs={sfJobs}
          pieceworkJobs={pieceworkJobs}
          totalRevenue={totalRevenue}
          totalLabor={hasPiecework ? totalLabor : null}
        />
      </div>
    </div>
  )
}
