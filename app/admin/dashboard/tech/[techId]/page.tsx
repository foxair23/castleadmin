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
    .select('id, full_name, sf_technician_id, weekly_bonus')
    .eq('sf_technician_id', techId)
    .maybeSingle()

  // ── Piecework jobs for this tech + week ───────────────────────────────────
  type PwJobRaw = {
    id: string
    job_name: string
    work_date: string
    total_pay: number
    sf_job_id: string | null
    sf_job_number: string | null
    items: { name: string; quantity: number; calculated_pay: number }[]
  }
  let pwJobRows: PwJobRaw[] = []

  if (techProfile?.id) {
    const { data: pwJobs } = await db
      .from('jobs')
      .select('id, job_name, work_date, total_pay, sf_job_id, sf_job_number')
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
        itemsByJob[jid].push({
          name: (item.job_types as any)?.name ?? 'Unknown',
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
        sf_job_number: j.sf_job_number as string | null,
        items: itemsByJob[j.id as string] ?? [],
      }))
    }
  }

  // ── SF revenue lookup for piecework jobs ──────────────────────────────────
  // Look up by specific sf_job_id with NO date filter — piecework is often
  // submitted in a different week than the SF job's completed_at date.
  const pwSfJobIds = pwJobRows.map(j => j.sf_job_id).filter((id): id is string => id !== null)
  const sfRevenueById = new Map<string, number | null>()
  if (pwSfJobIds.length > 0) {
    const { data: sfLookup } = await db
      .from('sf_jobs_cache')
      .select('id, total_amount')
      .in('id', pwSfJobIds)
    for (const j of sfLookup ?? []) {
      sfRevenueById.set(j.id as string, (j.total_amount as number | null))
    }
  }

  // ── SF jobs completed this week, assigned to this tech ────────────────────
  // Same query order as the scoreboard: week jobs first, then filter by tech.
  type SfJobRaw = { id: string; total_amount: number | null; completed_at: string | null }
  let sfJobRows: SfJobRaw[] = []

  const { data: weekJobs } = await db
    .from('sf_jobs_cache')
    .select('id, total_amount, completed_at')
    .eq('is_closed', true)
    .gte('completed_at', weekStart + 'T00:00:00')
    .lte('completed_at', wkEnd + 'T23:59:59')
    .not('completed_at', 'is', null)
    .not('customer_id', 'is', null)
    .neq('customer_id', '')

  const weekJobIds = (weekJobs ?? []).map(j => j.id as string)
  const weekJobMap = new Map((weekJobs ?? []).map(j => [j.id as string, j as SfJobRaw]))

  if (weekJobIds.length > 0) {
    const { data: techAssignments } = await db
      .from('sf_job_techs_cache')
      .select('sf_job_id')
      .eq('sf_tech_id', techId)
      .in('sf_job_id', weekJobIds)

    sfJobRows = (techAssignments ?? [])
      .map(a => weekJobMap.get(a.sf_job_id as string))
      .filter((j): j is SfJobRaw => j !== undefined)
      .sort((a, b) => (a.completed_at ?? '').localeCompare(b.completed_at ?? ''))
  }

  // ── Enrich SF-only rows with customer name + job number from sf_jobs ──────
  // sf_jobs_cache doesn't expose these fields, so fetch them directly.
  type SfJobMeta = { id: string; number: string | null; customer_name: string | null }
  const sfJobMetaMap = new Map<string, SfJobMeta>()
  const sfOnlyIds = sfJobRows.map(j => j.id)
  if (sfOnlyIds.length > 0) {
    const { data: sfMeta } = await db
      .from('sf_jobs')
      .select('id, number, customer_name')
      .in('id', sfOnlyIds)
    for (const m of sfMeta ?? []) {
      sfJobMetaMap.set(m.id as string, {
        id: m.id as string,
        number: m.number as string | null,
        customer_name: m.customer_name as string | null,
      })
    }
  }

  // ── Build unified rows ────────────────────────────────────────────────────
  type UnifiedRow = {
    key: string
    date: string
    sfJobId: string | null
    sfJobNumber: string | null
    customerName: string | null
    jobName: string | null
    revenue: number | null
    labor: number | null
    items: PwJobRaw['items']
  }

  const sfJobMap = new Map(sfJobRows.map(j => [j.id, j]))
  const usedSfIds = new Set<string>()
  const rows: UnifiedRow[] = []

  // First pass: piecework jobs — revenue from sfRevenueById (no date restriction)
  for (const pw of pwJobRows) {
    if (pw.sf_job_id) usedSfIds.add(pw.sf_job_id)
    const sfInWeek = pw.sf_job_id ? sfJobMap.get(pw.sf_job_id) : undefined
    const revenue = pw.sf_job_id !== null ? (sfRevenueById.get(pw.sf_job_id) ?? null) : null
    rows.push({
      key: pw.id,
      date: sfInWeek?.completed_at?.slice(0, 10) ?? pw.work_date,
      sfJobId: pw.sf_job_id,
      sfJobNumber: pw.sf_job_number,
      customerName: pw.sf_job_id ? (sfJobMetaMap.get(pw.sf_job_id)?.customer_name ?? null) : null,
      jobName: pw.job_name,
      revenue,
      labor: pw.total_pay,
      items: pw.items,
    })
  }

  // Second pass: SF jobs with no matching piecework entry
  for (const sf of sfJobRows) {
    if (usedSfIds.has(sf.id)) continue
    const meta = sfJobMetaMap.get(sf.id)
    rows.push({
      key: sf.id,
      date: sf.completed_at!.slice(0, 10),
      sfJobId: sf.id,
      sfJobNumber: meta?.number ?? null,
      customerName: meta?.customer_name ?? null,
      jobName: null,
      revenue: sf.total_amount ?? null,
      labor: null,
      items: [],
    })
  }

  // Sort by date
  rows.sort((a, b) => a.date.localeCompare(b.date))

  const weeklyBonus = (techProfile?.weekly_bonus as number | null) ?? 0
  const totalRevenue = rows.reduce((s, r) => s + (r.revenue ?? 0), 0)
  const pieceworkLabor = pwJobRows.length > 0
    ? rows.reduce((s, r) => s + (r.labor ?? 0), 0)
    : null
  const totalLabor = pieceworkLabor !== null ? pieceworkLabor + weeklyBonus
    : weeklyBonus > 0 ? weeklyBonus
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
          weeklyBonus={weeklyBonus}
          hasPieceworkLink={!!techProfile?.id}
        />
      </div>
    </div>
  )
}
