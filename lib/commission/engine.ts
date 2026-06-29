/**
 * Commission engine — DB orchestration (TRD §5.3, build step 4 & 11).
 *
 * Two operations, plus an orchestrator:
 *   populateEligibility()  — scan candidate jobs, apply §3.3 rules, upsert
 *                            commission_job_eligibility (preserving admin
 *                            decisions and frozen revenue).
 *   recomputeSnapshots()   — derive per-tech-per-period rollups via the calc
 *                            engine and cache them in commission_calc_snapshots.
 *   refreshCommission()    — populate then recompute. Called on sync completion,
 *                            and on demand (plan/eligibility/adjustment change).
 *
 * All figures remain derivable from the inputs; snapshots are only a cache.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { COMMISSION_START_DATE, periodForRecognitionDate } from './periods'
import { buildResolver, classifyJob, type AgentMapping, type AgentOnJob } from './eligibility'
import { computeCommission, type CommissionPlan, type EligibleJob } from './calc'

function db(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

// Statuses excluded from revenue everywhere else in the app (cancelled jobs are
// not real revenue) — mirror that here.
const EXCLUDED_STATUSES = ['Cancelled', 'Void', 'Voided']

/** Page through every matching row past PostgREST's 1000-row cap. */
async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const PAGE = 1000
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1)
    if (error) throw new Error(`commission fetchAll failed: ${JSON.stringify(error)}`)
    if (!data || data.length === 0) break
    out.push(...data)
    if (data.length < PAGE) break
  }
  return out
}

interface JobRow { id: string; closed_at: string | null; total: number | null }
interface AgentRow { job_id: string; agent_id: string | null; agent_first_name: string | null; agent_last_name: string | null }
interface EligRow {
  sf_job_id: string
  tech_user_id: string | null
  recognition_date: string
  revenue: number
  revenue_frozen: boolean
  status: string
  review_reason: string | null
  resolved_at: string | null
}

// ── Populate eligibility ────────────────────────────────────────────────────

export async function populateEligibility(): Promise<{ scanned: number; written: number }> {
  const supabase = db()

  // 1. Agent → tech map.
  const { data: mapData, error: mapErr } = await supabase
    .from('commission_agent_map')
    .select('tech_user_id, agent_id, agent_first_name, agent_last_name')
  if (mapErr) throw new Error(`load agent map: ${mapErr.message}`)
  const resolver = buildResolver((mapData ?? []) as AgentMapping[])

  // 2. Candidate jobs: completed on/after the start date, not cancelled/deleted.
  const jobs = await fetchAll<JobRow>((from, to) =>
    supabase
      .from('sf_jobs')
      .select('id, closed_at, total')
      .eq('is_deleted', false)
      .not('status', 'in', `(${EXCLUDED_STATUSES.map(s => `"${s}"`).join(',')})`)
      .gte('closed_at', COMMISSION_START_DATE)
      .order('id', { ascending: true })
      .range(from, to),
  )
  const jobIds = jobs.map(j => j.id)

  // 3. Agents per job.
  const agentRows = await fetchAll<AgentRow>((from, to) =>
    supabase
      .from('sf_job_agents')
      .select('job_id, agent_id, agent_first_name, agent_last_name')
      .order('job_id', { ascending: true })
      .range(from, to),
  )
  const agentsByJob = new Map<string, AgentOnJob[]>()
  for (const a of agentRows) {
    if (!agentsByJob.has(a.job_id)) agentsByJob.set(a.job_id, [])
    agentsByJob.get(a.job_id)!.push(a)
  }

  // 4. Collection state: jobs with a paid, live invoice are collected.
  const paidInvoices = await fetchAll<{ job_id: string | null }>((from, to) =>
    supabase
      .from('sf_invoices')
      .select('job_id')
      .eq('is_paid', true)
      .eq('is_deleted', false)
      .not('job_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, to),
  )
  const collected = new Set(paidInvoices.map(i => i.job_id!).filter(Boolean))

  // 5. Existing rows, to preserve admin decisions and frozen revenue.
  const existingRows = await fetchAll<EligRow>((from, to) =>
    supabase
      .from('commission_job_eligibility')
      .select('sf_job_id, tech_user_id, recognition_date, revenue, revenue_frozen, status, review_reason, resolved_at')
      .order('sf_job_id', { ascending: true })
      .range(from, to),
  )
  const existingByJob = new Map(existingRows.map(r => [r.sf_job_id, r]))

  const now = new Date().toISOString()
  const upserts: Record<string, unknown>[] = []
  const deletes: string[] = []

  for (const job of jobs) {
    const agents = agentsByJob.get(job.id) ?? []
    const classification = classifyJob(agents, resolver)
    const existing = existingByJob.get(job.id)

    // Job carries no agents → not attributable to any rep, so it's not a
    // commission job at all. Drop the eligibility row even if an admin had
    // resolved/denied it: removing the agent in SF un-associates the job from
    // the rep, so it should disappear from their commission tab entirely.
    if (!classification) {
      if (existing) deletes.push(job.id)
      continue
    }

    const recognition_date = (job.closed_at ?? '').slice(0, 10)
    const isCollected = collected.has(job.id)
    const liveTotal = job.total ?? 0

    // Revenue: live until collected, then frozen (decision #3). Keep a frozen
    // value frozen; otherwise track the current job total.
    let revenue: number
    let revenue_frozen: boolean
    if (existing?.revenue_frozen) {
      revenue = existing.revenue
      revenue_frozen = true
    } else if (isCollected) {
      revenue = liveTotal
      revenue_frozen = true
    } else {
      revenue = liveTotal
      revenue_frozen = false
    }

    // Preserve admin decisions: a row that's been resolved or toggled
    // not_accepted keeps its status/tech/reason; we only refresh revenue.
    const adminDecided = existing && (existing.resolved_at != null || existing.status === 'not_accepted')

    if (adminDecided) {
      upserts.push({
        sf_job_id: job.id,
        tech_user_id: existing!.tech_user_id,
        recognition_date,
        revenue,
        revenue_frozen,
        status: existing!.status,
        review_reason: existing!.review_reason,
        updated_at: now,
      })
    } else {
      upserts.push({
        sf_job_id: job.id,
        tech_user_id: classification.tech_user_id,
        recognition_date,
        revenue,
        revenue_frozen,
        status: classification.status,
        review_reason: classification.review_reason,
        updated_at: now,
      })
    }
  }

  // Apply.
  if (deletes.length > 0) {
    for (let i = 0; i < deletes.length; i += 200) {
      const { error } = await supabase
        .from('commission_job_eligibility')
        .delete()
        .in('sf_job_id', deletes.slice(i, i + 200))
      if (error) throw new Error(`delete stale eligibility: ${error.message}`)
    }
  }
  for (let i = 0; i < upserts.length; i += 200) {
    const { error } = await supabase
      .from('commission_job_eligibility')
      .upsert(upserts.slice(i, i + 200), { onConflict: 'sf_job_id' })
    if (error) throw new Error(`upsert eligibility: ${error.message}`)
  }

  return { scanned: jobs.length, written: upserts.length }
}

// ── Recompute snapshots ─────────────────────────────────────────────────────

interface PlanRow {
  tech_user_id: string
  period_start: string
  period_end: string
  sales_target: number
  rate_below: number
  rate_above: number
}
interface AdjRow { tech_user_id: string; period_start: string; period_end: string; amount: number }

function periodKey(techUserId: string, start: string, end: string): string {
  return `${techUserId}|${start}|${end}`
}

export async function recomputeSnapshots(): Promise<{ snapshots: number }> {
  const supabase = db()

  // Eligible, credited jobs only feed the formula.
  const elig = await fetchAll<EligRow>((from, to) =>
    supabase
      .from('commission_job_eligibility')
      .select('sf_job_id, tech_user_id, recognition_date, revenue, revenue_frozen, status, review_reason, resolved_at')
      .eq('status', 'eligible')
      .not('tech_user_id', 'is', null)
      .order('sf_job_id', { ascending: true })
      .range(from, to),
  )

  const plans = await fetchAll<PlanRow>((from, to) =>
    supabase
      .from('commission_plans')
      .select('tech_user_id, period_start, period_end, sales_target, rate_below, rate_above')
      .order('id', { ascending: true })
      .range(from, to),
  )
  const adjustments = await fetchAll<AdjRow>((from, to) =>
    supabase
      .from('commission_adjustments')
      .select('tech_user_id, period_start, period_end, amount')
      .order('id', { ascending: true })
      .range(from, to),
  )

  // Group everything by (tech, period). Keys come from jobs, plans, and
  // adjustments so a period with only an adjustment still produces a snapshot.
  interface Bucket {
    tech_user_id: string
    period_start: string
    period_end: string
    jobs: EligibleJob[]
    plan: CommissionPlan | null
    adjustments: number[]
  }
  const buckets = new Map<string, Bucket>()

  function ensure(tech: string, start: string, end: string): Bucket {
    const k = periodKey(tech, start, end)
    let b = buckets.get(k)
    if (!b) {
      b = { tech_user_id: tech, period_start: start, period_end: end, jobs: [], plan: null, adjustments: [] }
      buckets.set(k, b)
    }
    return b
  }

  for (const j of elig) {
    const p = periodForRecognitionDate(j.recognition_date)
    if (!p || !j.tech_user_id) continue
    const b = ensure(j.tech_user_id, p.start, p.end)
    b.jobs.push({
      sf_job_id: j.sf_job_id,
      recognition_date: j.recognition_date,
      revenue: j.revenue,
      collected: j.revenue_frozen, // frozen ⇔ collected (set together in populate)
    })
  }
  for (const pl of plans) {
    const b = ensure(pl.tech_user_id, pl.period_start, pl.period_end)
    b.plan = { sales_target: pl.sales_target, rate_below: pl.rate_below, rate_above: pl.rate_above }
  }
  for (const a of adjustments) {
    const b = ensure(a.tech_user_id, a.period_start, a.period_end)
    b.adjustments.push(a.amount)
  }

  const now = new Date().toISOString()
  const rows: Record<string, unknown>[] = []
  for (const b of buckets.values()) {
    const res = computeCommission(b.jobs, b.plan, b.adjustments)
    rows.push({
      tech_user_id: b.tech_user_id,
      period_start: b.period_start,
      period_end: b.period_end,
      // Tier/commission are measured on RECEIVED revenue; the job is still
      // attributed to its completion month (handled by the period grouping).
      eligible_revenue: res.received_revenue,
      commission_earned: res.commission_received,
      commission_payable: res.commission_received,
      commission_pending: res.commission_pending,
      computed_at: now,
    })
  }

  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabase
      .from('commission_calc_snapshots')
      .upsert(rows.slice(i, i + 200), { onConflict: 'tech_user_id,period_start,period_end' })
    if (error) throw new Error(`upsert snapshots: ${error.message}`)
  }

  return { snapshots: rows.length }
}

// ── Orchestrator ────────────────────────────────────────────────────────────

export async function refreshCommission(): Promise<{
  scanned: number; written: number; snapshots: number
}> {
  const { scanned, written } = await populateEligibility()
  const { snapshots } = await recomputeSnapshots()
  return { scanned, written, snapshots }
}
