/**
 * Per-tech, per-period commission detail (TRD §7).
 *
 * Builds the technician Commission tab payload: the period summary plus the
 * job-level pipeline whose per-job commission amounts sum to the period total.
 * Shared by the tech route (self only) and the admin all-tech view.
 *
 * Decision #1: jobs that are sold but not yet completed have no recognition
 * date, so they're shown in a separate "open" bucket and contribute $0 to the
 * period until they complete.
 */

import { type SupabaseClient } from '@supabase/supabase-js'
import { computeCommission, type EligibleJob } from './calc'
import { type Period } from './periods'

export type Stage = 'Sold' | 'Completed' | 'Invoiced' | 'Paid'

export interface JobLine {
  sf_job_id: string
  job_number: string | null
  customer_name: string | null
  recognition_date: string
  revenue: number
  commission: number
  collected: boolean
  payable: boolean
  stage: Stage
  status: 'eligible' | 'not_accepted'
}

export interface OpenJobLine {
  sf_job_id: string
  job_number: string | null
  customer_name: string | null
  start_date: string | null
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
    eligible_revenue: number
    commission_earned: number
    commission_payable: number
    commission_pending: number
    adjustments_total: number
    sales_target: number | null
    has_plan: boolean
  }
  jobs: JobLine[]
  open_jobs: OpenJobLine[]
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

export async function computeTechPeriodDetail(
  db: SupabaseClient,
  techUserId: string,
  period: Period,
): Promise<TechPeriodDetail> {
  // 1. This tech's eligibility rows for the period (eligible drives the math;
  //    not_accepted is shown but excluded).
  const { data: eligData } = await db
    .from('commission_job_eligibility')
    .select('sf_job_id, recognition_date, revenue, revenue_frozen, status')
    .eq('tech_user_id', techUserId)
    .in('status', ['eligible', 'not_accepted'])
    .gte('recognition_date', period.start)
    .lte('recognition_date', period.end)
  const elig = (eligData ?? []) as EligRow[]
  const jobIds = elig.map(e => e.sf_job_id)

  // 2. Plan + adjustments for the period.
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
  const plan = planData
    ? { sales_target: planData.sales_target, rate_below: planData.rate_below, rate_above: planData.rate_above }
    : null
  const adjustments = (adjData ?? []) as AdjustmentLine[]

  // 3. Job metadata + invoice presence for the pipeline stage.
  const [{ data: jobMeta }, { data: invMeta }] = await Promise.all([
    jobIds.length
      ? db.from('sf_jobs').select('id, number, customer_name').in('id', jobIds)
      : Promise.resolve({ data: [] as { id: string; number: string | null; customer_name: string | null }[] }),
    jobIds.length
      ? db.from('sf_invoices').select('job_id').eq('is_deleted', false).in('job_id', jobIds)
      : Promise.resolve({ data: [] as { job_id: string | null }[] }),
  ])
  const metaById = new Map((jobMeta ?? []).map(j => [j.id, j]))
  const invoicedJobs = new Set((invMeta ?? []).map(i => i.job_id).filter(Boolean) as string[])

  // 4. Per-job commission via the calc engine (eligible rows only).
  const eligibleJobs: EligibleJob[] = elig
    .filter(e => e.status === 'eligible')
    .map(e => ({
      sf_job_id: e.sf_job_id,
      recognition_date: e.recognition_date,
      revenue: e.revenue,
      collected: e.revenue_frozen,
    }))
  const result = computeCommission(eligibleJobs, plan, adjustments.map(a => a.amount))
  const commByJob = new Map(result.jobs.map(j => [j.sf_job_id, j]))

  function stageFor(jobId: string, collected: boolean): Stage {
    if (collected) return 'Paid'
    if (invoicedJobs.has(jobId)) return 'Invoiced'
    return 'Completed'
  }

  const jobs: JobLine[] = elig.map(e => {
    const meta = metaById.get(e.sf_job_id)
    const c = commByJob.get(e.sf_job_id)
    return {
      sf_job_id: e.sf_job_id,
      job_number: meta?.number ?? null,
      customer_name: meta?.customer_name ?? null,
      recognition_date: e.recognition_date,
      revenue: e.revenue,
      commission: e.status === 'eligible' ? (c?.commission ?? 0) : 0,
      collected: e.revenue_frozen,
      payable: e.status === 'eligible' ? (c?.payable ?? 0) > 0 : false,
      stage: stageFor(e.sf_job_id, e.revenue_frozen),
      status: e.status as 'eligible' | 'not_accepted',
    }
  }).sort((a, b) => (a.recognition_date < b.recognition_date ? 1 : -1)) // newest first

  // 5. Open bucket: this tech's mapped agents' jobs that aren't completed yet.
  const open_jobs = await loadOpenJobs(db, techUserId)

  return {
    period: { start: period.start, end: period.end, label: period.label },
    summary: {
      eligible_revenue: result.eligible_revenue,
      commission_earned: result.commission_earned,
      commission_payable: result.commission_payable,
      commission_pending: result.commission_pending,
      adjustments_total: result.adjustments_total,
      sales_target: plan?.sales_target ?? null,
      has_plan: plan != null,
    },
    jobs,
    open_jobs,
    adjustments,
  }
}

/** Jobs sold by this tech (mapped agent) that haven't completed yet (§7.2, decision #1). */
async function loadOpenJobs(db: SupabaseClient, techUserId: string): Promise<OpenJobLine[]> {
  // Agent identities mapped to this tech.
  const { data: maps } = await db
    .from('commission_agent_map')
    .select('agent_id, agent_first_name, agent_last_name')
    .eq('tech_user_id', techUserId)
  if (!maps || maps.length === 0) return []

  const agentIds = maps.map(m => m.agent_id).filter(Boolean) as string[]
  if (agentIds.length === 0) return []

  // Jobs carrying those agents.
  const { data: agentJobs } = await db
    .from('sf_job_agents')
    .select('job_id')
    .in('agent_id', agentIds)
  const candidateIds = Array.from(new Set((agentJobs ?? []).map(a => a.job_id)))
  if (candidateIds.length === 0) return []

  // Of those, the ones not yet completed (no closed_at), not cancelled/deleted.
  const { data: openRows } = await db
    .from('sf_jobs')
    .select('id, number, customer_name, start_date, closed_at')
    .in('id', candidateIds)
    .is('closed_at', null)
    .eq('is_deleted', false)
    .not('status', 'in', EXCLUDED_STATUSES)
    .order('start_date', { ascending: false })

  return (openRows ?? []).map(j => ({
    sf_job_id: j.id,
    job_number: j.number,
    customer_name: j.customer_name,
    start_date: j.start_date,
    stage: 'Sold' as Stage,
  }))
}
