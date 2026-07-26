import { createClient } from '@supabase/supabase-js'
import type { Period } from './periods'

// Upsell tracking — compares each commission job's "before" baseline (the total
// captured at 7am PT on its service day) to its final commission revenue.
//
// Rules (confirmed with owner):
//   • "After"  = commission_job_eligibility.revenue (grand total, frozen at
//     collection — the exact figure the commission tab shows).
//   • "Before" = commission_job_baseline.baseline_total. A captured 0 counts as
//     a real baseline (whole final = upsell). No baseline row at all → excluded
//     from totals, shown as "—".
//   • Incremental = after − before, NET (downward revisions subtract).
//   • Avg % averages only jobs with a real (>0) baseline (% is undefined at 0).
//   • Scope = all commission-candidate jobs (every eligibility row in period),
//     attributed to the resolved tech; unresolved → an "Unassigned" bucket so
//     the per-tech rows always sum to the company total.

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

export const UNASSIGNED_KEY = 'unassigned'

export interface UpsellJobRow {
  sfJobId: string
  jobNumber: string | null
  customerName: string | null
  completedDate: string | null // work_completed_at ?? recognition_date
  before: number | null        // null when no baseline captured
  after: number
  incremental: number | null   // null when no baseline
  pct: number | null           // null when no baseline or baseline is 0 ("new")
  status: string
}

export interface UpsellTechRow {
  techKey: string              // techUserId, or UNASSIGNED_KEY
  techUserId: string | null
  techName: string
  jobs: number
  jobsWithBaseline: number
  before: number               // sum over baseline jobs
  after: number                // sum over baseline jobs
  incremental: number          // after − before (net)
  avgPct: number | null
}

export interface UpsellResult {
  total: { incremental: number; before: number; after: number; jobs: number; jobsWithBaseline: number }
  techRows: UpsellTechRow[]
  jobsByTech: Record<string, UpsellJobRow[]>
}

interface EligRow {
  sf_job_id: string
  tech_user_id: string | null
  recognition_date: string
  revenue: number | null
  status: string
}

export async function getUpsellForPeriod(period: Period): Promise<UpsellResult> {
  const supabase = db()

  // 1) Every commission-candidate job recognized in the period.
  const elig: EligRow[] = []
  let from = 0
  const PAGE = 1000
  for (;;) {
    const { data: page } = await supabase
      .from('commission_job_eligibility')
      .select('sf_job_id, tech_user_id, recognition_date, revenue, status')
      .gte('recognition_date', period.start)
      .lte('recognition_date', period.end)
      .order('sf_job_id')
      .range(from, from + PAGE - 1)
    if (!page || page.length === 0) break
    elig.push(...(page as EligRow[]))
    if (page.length < PAGE) break
    from += PAGE
  }

  const empty: UpsellResult = {
    total: { incremental: 0, before: 0, after: 0, jobs: 0, jobsWithBaseline: 0 },
    techRows: [],
    jobsByTech: {},
  }
  if (elig.length === 0) return empty

  const jobIds = [...new Set(elig.map(r => r.sf_job_id))]
  const techIds = [...new Set(elig.map(r => r.tech_user_id).filter((t): t is string => !!t))]

  // 2) Supporting data: job details, baselines, tech names.
  const [{ data: jobs }, { data: baselines }, { data: techs }] = await Promise.all([
    supabase.from('sf_jobs').select('id, number, customer_name, work_completed_at').in('id', jobIds),
    supabase.from('commission_job_baseline').select('sf_job_id, baseline_total').in('sf_job_id', jobIds),
    techIds.length > 0
      ? supabase.from('profiles').select('id, full_name').in('id', techIds)
      : Promise.resolve({ data: [] as { id: string; full_name: string | null }[] }),
  ])

  const jobMap = new Map((jobs ?? []).map(j => [j.id, j as { id: string; number: string | null; customer_name: string | null; work_completed_at: string | null }]))
  const baselineMap = new Map((baselines ?? []).map(b => [(b as { sf_job_id: string }).sf_job_id, (b as { baseline_total: number | null }).baseline_total]))
  const techNameById = new Map((techs ?? []).map(t => [(t as { id: string }).id, (t as { full_name: string | null }).full_name ?? '—']))

  // 3) Build per-job rows and bucket by tech.
  const jobsByTech: Record<string, UpsellJobRow[]> = {}
  const techAgg = new Map<string, { techUserId: string | null; jobs: number; jobsWithBaseline: number; before: number; after: number; incremental: number; pctSum: number; pctCount: number }>()

  const total = { incremental: 0, before: 0, after: 0, jobs: 0, jobsWithBaseline: 0 }

  for (const r of elig) {
    const job = jobMap.get(r.sf_job_id)
    const after = r.revenue ?? 0
    const hasBaseline = baselineMap.has(r.sf_job_id)
    const before = hasBaseline ? (baselineMap.get(r.sf_job_id) ?? 0) : null
    const incremental = before === null ? null : after - before
    const pct = before === null || before <= 0 ? null : (after - before) / before

    const row: UpsellJobRow = {
      sfJobId: r.sf_job_id,
      jobNumber: job?.number ?? null,
      customerName: job?.customer_name ?? null,
      completedDate: job?.work_completed_at ?? r.recognition_date ?? null,
      before,
      after,
      incremental,
      pct,
      status: r.status,
    }

    const key = r.tech_user_id ?? UNASSIGNED_KEY
    ;(jobsByTech[key] ??= []).push(row)

    let agg = techAgg.get(key)
    if (!agg) {
      agg = { techUserId: r.tech_user_id, jobs: 0, jobsWithBaseline: 0, before: 0, after: 0, incremental: 0, pctSum: 0, pctCount: 0 }
      techAgg.set(key, agg)
    }
    agg.jobs++
    total.jobs++
    if (before !== null) {
      agg.jobsWithBaseline++
      agg.before += before
      agg.after += after
      agg.incremental += (incremental ?? 0)
      total.jobsWithBaseline++
      total.before += before
      total.after += after
      total.incremental += (incremental ?? 0)
      if (pct !== null) { agg.pctSum += pct; agg.pctCount++ }
    }
  }

  // 4) Assemble tech rows, sorted by incremental desc. Each job list sorted the
  //    same way (baseline jobs first, biggest upsell first; "—" jobs last).
  const techRows: UpsellTechRow[] = [...techAgg.entries()].map(([key, a]) => ({
    techKey: key,
    techUserId: a.techUserId,
    techName: a.techUserId ? (techNameById.get(a.techUserId) ?? '—') : 'Unassigned (needs review)',
    jobs: a.jobs,
    jobsWithBaseline: a.jobsWithBaseline,
    before: a.before,
    after: a.after,
    incremental: a.incremental,
    avgPct: a.pctCount > 0 ? a.pctSum / a.pctCount : null,
  })).sort((x, y) => y.incremental - x.incremental || x.techName.localeCompare(y.techName))

  for (const key of Object.keys(jobsByTech)) {
    jobsByTech[key].sort((x, y) => {
      if (x.incremental === null && y.incremental === null) return 0
      if (x.incremental === null) return 1
      if (y.incremental === null) return -1
      return y.incremental - x.incremental
    })
  }

  return { total, techRows, jobsByTech }
}
