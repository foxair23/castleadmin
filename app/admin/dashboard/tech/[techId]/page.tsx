import { redirect } from 'next/navigation'
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

  // Look up profile by sf_technician_id to get the piecework UUID
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

  type SfJobRaw = { id: string; total_amount: number | null; completed_at: string | null }
  let sfJobRows: SfJobRaw[] = []
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
    sfJobRows = (data ?? []) as SfJobRaw[]
  }

  // Fetch piecework jobs for this tech + week (including sf_job_id for joining)
  type PwJobRaw = {
    id: string
    job_name: string
    work_date: string
    total_pay: number
    sf_job_id: string | null
    items: { name: string; quantity: number; calculated_pay: number }[]
  }
  let pwJobRows: PwJobRaw[] = []

  if (techProfile?.id) {
    const { data: pwJobs } = await db
      .from('jobs')
      .select('id, job_name, work_date, total_pay, sf_job_id')
      .eq('tech_id', techProfile.id)
      .eq('week_start_date', weekStart)
      .order('work_date', { ascending: true })

    if (pwJobs && pwJobs.length > 0) {
      const jobIds = pwJobs.map(j => j.id as string)
      const { data: items } = await db
        .from('job_work_items')
        .select('job_id, quantity, calculated_pay, job_types(name)')
        .in('job_id', jobIds)

      const itemsByJob: Record<string, PwJobRaw['items']> = {}
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

      pwJobRows = pwJobs.map(j => ({
        id: j.id as string,
        job_name: j.job_name as string,
        work_date: j.work_date as string,
        total_pay: j.total_pay as number,
        sf_job_id: j.sf_job_id as string | null,
        items: itemsByJob[j.id as string] ?? [],
      }))
    }
  }

  // Build unified rows: join SF jobs + piecework by sf_job_id where possible
  type UnifiedRow = {
    key: string
    date: string
    sfJobId: string | null
    jobName: string | null
    revenue: number | null
    labor: number | null
    items: PwJobRaw['items']
  }

  const sfJobMap = new Map(sfJobRows.map(j => [j.id, j]))
  const usedSfIds = new Set<string>()
  const rows: UnifiedRow[] = []

  // First pass: piecework jobs (may join to SF)
  for (const pw of pwJobRows) {
    const sf = pw.sf_job_id ? sfJobMap.get(pw.sf_job_id) : null
    if (sf) usedSfIds.add(sf.id)
    rows.push({
      key: pw.id,
      date: sf?.completed_at?.slice(0, 10) ?? pw.work_date,
      sfJobId: sf?.id ?? null,
      jobName: pw.job_name,
      revenue: sf?.total_amount ?? null,
      labor: pw.total_pay,
      items: pw.items,
    })
  }

  // Second pass: SF jobs with no matching piecework entry
  for (const sf of sfJobRows) {
    if (usedSfIds.has(sf.id)) continue
    rows.push({
      key: sf.id,
      date: sf.completed_at!.slice(0, 10),
      sfJobId: sf.id,
      jobName: null,
      revenue: sf.total_amount,
      labor: null,
      items: [],
    })
  }

  // Sort by date
  rows.sort((a, b) => a.date.localeCompare(b.date))

  const totalRevenue = rows.reduce((s, r) => s + (r.revenue ?? 0), 0)
  const totalLabor = pwJobRows.length > 0
    ? rows.reduce((s, r) => s + (r.labor ?? 0), 0)
    : null

  const techName = techProfile?.full_name ?? `Tech ${techId}`

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        <Link href="/admin/dashboard" className="text-sm text-gray-500 hover:text-gray-700 font-medium">
          ← Dashboard
        </Link>
        <TechDetailClient
          techName={techName}
          weekStart={weekStart}
          weekEnd={wkEnd}
          rows={rows}
          totalRevenue={totalRevenue}
          totalLabor={totalLabor}
          hasPieceworkLink={!!techProfile?.id}
        />
      </div>
    </div>
  )
}
