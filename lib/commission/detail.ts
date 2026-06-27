/**
 * Per-tech, per-period commission detail (TRD §7).
 *
 * Builds the technician Commission tab payload: a payout-centric summary plus a
 * single job pipeline. Every job shows a commission number; a rep only
 * *receives* it when the company is paid, so anything not yet collected is
 * labelled "payment pending" — never "earned".
 *
 * The commission tier/rate is anchored to the month the work was COMPLETED
 * (unchanged). Jobs not yet completed are shown with a PROJECTED commission,
 * computed as their marginal contribution layered on top of the period's
 * completed revenue — so the real (completed) figures are never affected.
 */

import { type SupabaseClient } from '@supabase/supabase-js'
import { computeCommission, type CommissionPlan, type EligibleJob } from './calc'
import { type Period } from './periods'

export type Stage = 'Sold' | 'Scheduled' | 'Completed' | 'Invoiced' | 'Payment Received'

export interface JobLine {
  sf_job_id: string
  job_number: string | null
  customer_name: string | null
  /** Completion date for completed jobs, scheduled date for not-yet-performed. */
  date: string | null
  revenue: number
  commission: number
  /** Commission has been received (job collected). */
  received: boolean
  /** This commission is a projection (job not yet completed). */
  projected: boolean
  stage: Stage
}

export interface AdjustmentLine {
  amount: number
  note: string
  created_at: string
}

export interface TechPeriodDetail {
  period: { start: string; end: string; label: string }
  summary: {
    /** Recognized (completed, eligible) revenue in the period — drives the tier. */
    eligible_revenue: number
    /** Quoted value of scheduled-but-not-completed jobs in the period. */
    scheduled_revenue: number
    sales_target: number | null
    has_plan: boolean
    /** Commission actually received (collected jobs) + adjustments. */
    commission_received: number
    /** Not-yet-received commission: completed-unpaid (real) + scheduled (projected). */
    commission_pending: number
    /** received + pending — what they'd get if everything pays. */
    commission_total: number
    adjustments_total: number
  }
  jobs: JobLine[]
  adjustments: AdjustmentLine[]
}

const EXCLUDED_STATUSES = '("Cancelled","Void","Voided")'

interface EligRow {
  sf_job_id: string
  recognition_date: string
  revenue: number
  revenue_frozen: boolean
  status: 'eligible' | 'not_accepted' | 'needs_review'
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** Marginal commission for revenue `v` added at running cumulative `from`. */
function marginal(from: number, v: number, plan: CommissionPlan): number {
  const target = plan.sales_target
  const below = Math.max(0, Math.min(from + v, target) - from)
  const above = Math.max(0, from + v - Math.max(from, target))
  return round2(below * plan.rate_below + above * plan.rate_above)
}

export async function computeTechPeriodDetail(
  db: SupabaseClient,
  techUserId: string,
  period: Period,
): Promise<TechPeriodDetail> {
  // 1. Completed/eligible rows for the period (eligible drives the math).
  const { data: eligData } = await db
    .from('commission_job_eligibility')
    .select('sf_job_id, recognition_date, revenue, revenue_frozen, status')
    .eq('tech_user_id', techUserId)
    .eq('status', 'eligible')
    .gte('recognition_date', period.start)
    .lte('recognition_date', period.end)
  const elig = (eligData ?? []) as EligRow[]
  const eligIds = elig.map(e => e.sf_job_id)

  // 2. Plan + adjustments.
  const [{ data: planData }, { data: adjData }] = await Promise.all([
    db.from('commission_plans')
      .select('sales_target, rate_below, rate_above')
      .eq('tech_user_id', techUserId).eq('period_start', period.start).eq('period_end', period.end)
      .maybeSingle(),
    db.from('commission_adjustments')
      .select('amount, note, created_at')
      .eq('tech_user_id', techUserId).eq('period_start', period.start).eq('period_end', period.end)
      .order('created_at', { ascending: true }),
  ])
  const plan: CommissionPlan | null = planData
    ? { sales_target: planData.sales_target, rate_below: planData.rate_below, rate_above: planData.rate_above }
    : null
  const adjustments = (adjData ?? []) as AdjustmentLine[]

  // 3. Job metadata + invoice presence (for the pipeline stage).
  const [{ data: jobMeta }, { data: invMeta }] = await Promise.all([
    eligIds.length
      ? db.from('sf_jobs').select('id, number, customer_name').in('id', eligIds)
      : Promise.resolve({ data: [] as { id: string; number: string | null; customer_name: string | null }[] }),
    eligIds.length
      ? db.from('sf_invoices').select('job_id').eq('is_deleted', false).in('job_id', eligIds)
      : Promise.resolve({ data: [] as { job_id: string | null }[] }),
  ])
  const metaById = new Map((jobMeta ?? []).map(j => [j.id, j]))
  const invoicedJobs = new Set((invMeta ?? []).map(i => i.job_id).filter(Boolean) as string[])

  // 4. Real per-job commission for completed jobs (canonical, matches snapshots).
  const eligibleJobs: EligibleJob[] = elig.map(e => ({
    sf_job_id: e.sf_job_id,
    recognition_date: e.recognition_date,
    revenue: e.revenue,
    collected: e.revenue_frozen,
  }))
  const result = computeCommission(eligibleJobs, plan, adjustments.map(a => a.amount))
  const commByJob = new Map(result.jobs.map(j => [j.sf_job_id, j]))

  function completedStage(jobId: string, collected: boolean): Stage {
    if (collected) return 'Payment Received'
    if (invoicedJobs.has(jobId)) return 'Invoiced'
    return 'Completed'
  }

  const completedLines: JobLine[] = elig.map(e => {
    const meta = metaById.get(e.sf_job_id)
    const c = commByJob.get(e.sf_job_id)
    return {
      sf_job_id: e.sf_job_id,
      job_number: meta?.number ?? null,
      customer_name: meta?.customer_name ?? null,
      date: e.recognition_date,
      revenue: e.revenue,
      commission: c?.commission ?? 0,
      received: e.revenue_frozen,
      projected: false,
      stage: completedStage(e.sf_job_id, e.revenue_frozen),
    }
  })

  // 5. Open (not-yet-completed) jobs → projected commission, layered on top of
  //    the completed revenue total so real figures are intact. Split into:
  //    Scheduled (has a date in this period — expected to land this month) and
  //    Sold (no date yet — backlog that shows in every month until scheduled).
  const openLines = await loadOpenLines(db, techUserId, period, plan, result.eligible_revenue)
  const scheduledLines = openLines.filter(j => j.stage === 'Scheduled')

  // 6. Summary (payout-centric).
  const commission_received = result.commission_payable // collected + adjustments
  const projected_scheduled = round2(scheduledLines.reduce((s, j) => s + j.commission, 0))
  const commission_pending = round2(result.commission_pending + projected_scheduled)
  const commission_total = round2(commission_received + commission_pending)
  const scheduled_revenue = round2(scheduledLines.reduce((s, j) => s + j.revenue, 0))

  const jobs = [...completedLines, ...openLines].sort((a, b) =>
    (a.date ?? '') < (b.date ?? '') ? 1 : (a.date ?? '') > (b.date ?? '') ? -1 : 0,
  )

  return {
    period: { start: period.start, end: period.end, label: period.label },
    summary: {
      eligible_revenue: result.eligible_revenue,
      scheduled_revenue,
      sales_target: plan?.sales_target ?? null,
      has_plan: plan != null,
      commission_received,
      commission_pending,
      commission_total,
      adjustments_total: result.adjustments_total,
    },
    jobs,
    adjustments,
  }
}

/**
 * Open jobs (mapped agent, not completed), split into two stages:
 *   • Scheduled — has a start_date within this period; expected to land revenue
 *     this month if completed on time.
 *   • Sold — no scheduled date yet; backlog shown in every period until it's
 *     scheduled and we know which month it'll complete in.
 * Jobs scheduled for a different period are omitted here (they appear in that
 * period's Scheduled bucket).
 */
async function loadOpenLines(
  db: SupabaseClient,
  techUserId: string,
  period: Period,
  plan: CommissionPlan | null,
  completedRevenueTotal: number,
): Promise<JobLine[]> {
  const { data: maps } = await db
    .from('commission_agent_map')
    .select('agent_id')
    .eq('tech_user_id', techUserId)
  const agentIds = (maps ?? []).map(m => m.agent_id).filter(Boolean) as string[]
  if (agentIds.length === 0) return []

  const { data: agentJobs } = await db
    .from('sf_job_agents').select('job_id').in('agent_id', agentIds)
  const candidateIds = Array.from(new Set((agentJobs ?? []).map(a => a.job_id)))
  if (candidateIds.length === 0) return []

  const { data: openRows } = await db
    .from('sf_jobs')
    .select('id, number, customer_name, start_date, total, closed_at')
    .in('id', candidateIds)
    .is('closed_at', null)
    .eq('is_deleted', false)
    .not('status', 'in', EXCLUDED_STATUSES)

  // Partition: Scheduled (dated, in this period) vs Sold (undated backlog).
  // Drop jobs scheduled for a different period.
  type Row = { id: string; number: string | null; customer_name: string | null; start_date: string | null; total: number | null }
  const scheduled: Row[] = []
  const sold: Row[] = []
  for (const j of (openRows ?? []) as Row[]) {
    const d = j.start_date
    if (!d) sold.push(j)
    else if (d >= period.start && d <= period.end) scheduled.push(j)
    // else: scheduled for another period — skip here.
  }
  scheduled.sort((a, b) => (a.start_date! < b.start_date! ? -1 : 1))

  // Layer projected commission on top of completed revenue: scheduled first
  // (date order), then the undated sold backlog.
  let C = completedRevenueTotal
  const project = (j: Row, stage: Stage): JobLine => {
    const revenue = j.total ?? 0
    const commission = plan ? marginal(C, revenue, plan) : 0
    C += revenue
    return {
      sf_job_id: j.id,
      job_number: j.number,
      customer_name: j.customer_name,
      date: stage === 'Scheduled' ? j.start_date : null,
      revenue,
      commission,
      received: false,
      projected: true,
      stage,
    }
  }

  return [
    ...scheduled.map(j => project(j, 'Scheduled')),
    ...sold.map(j => project(j, 'Sold')),
  ]
}
