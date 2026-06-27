/**
 * Commission calculation engine (TRD §4, revised).
 *
 * Pure functions — no I/O. The model:
 *   • A job belongs to the month its work was COMPLETED (period attribution
 *     lives in the engine; this file is period-agnostic).
 *   • The sales target and the two-tier rate are measured against RECEIVED
 *     (collected) revenue — a tech climbs toward the target, and into the
 *     higher tier, only as customer payments come in.
 *   • Commission is earned/payable on received revenue. Completed-but-unpaid
 *     work shows a PROJECTED commission (what it will earn when paid), layered
 *     on top of the received total so the real figures never move.
 *
 * Two-tier formula on received revenue R (§4.3):
 *   commission = min(R, target)·rate_below + max(0, R−target)·rate_above
 */

export interface CommissionPlan {
  sales_target: number
  rate_below: number
  rate_above: number
}

export interface EligibleJob {
  sf_job_id: string
  /** 'YYYY-MM-DD' completion date — used for deterministic ordering. */
  recognition_date: string
  revenue: number
  /** True once the job's payment is received (collected). */
  collected: boolean
}

export interface JobCommission {
  sf_job_id: string
  revenue: number
  /** Real commission (received jobs) or projected (completed-but-unpaid). */
  commission: number
  collected: boolean
  /** True when the figure is a projection (job not yet paid). */
  projected: boolean
}

export interface CommissionResult {
  /** Revenue actually received — drives the target and the tier. */
  received_revenue: number
  /** All completed (eligible) revenue in the period, paid or not. */
  completed_revenue: number
  /** Commission on received revenue + adjustments (what's payable). */
  commission_received: number
  /** Projected commission on completed-but-unpaid jobs. */
  commission_pending: number
  adjustments_total: number
  /** Running tier base after received + unpaid-completed revenue, so callers
   *  can layer further projections (scheduled/sold) on top. */
  cumulative_after_completed: number
  jobs: JobCommission[]
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** The two-tier commission on a revenue total R (§4.3). */
export function commissionOnRevenue(R: number, plan: CommissionPlan): number {
  const below = Math.min(R, plan.sales_target) * plan.rate_below
  const above = Math.max(0, R - plan.sales_target) * plan.rate_above
  return round2(below + above)
}

/** Marginal commission for revenue `v` added at running cumulative `from`. */
export function marginal(from: number, v: number, plan: CommissionPlan): number {
  const target = plan.sales_target
  const below = Math.max(0, Math.min(from + v, target) - from)
  const above = Math.max(0, from + v - Math.max(from, target))
  return round2(below * plan.rate_below + above * plan.rate_above)
}

function ordered(jobs: EligibleJob[]): EligibleJob[] {
  return [...jobs].sort((a, b) => {
    if (a.recognition_date !== b.recognition_date) return a.recognition_date < b.recognition_date ? -1 : 1
    return a.sf_job_id < b.sf_job_id ? -1 : a.sf_job_id > b.sf_job_id ? 1 : 0
  })
}

/**
 * Period computation for one tech.
 *
 * @param jobs        completed (eligible) jobs for the period, each flagged
 *                    collected or not
 * @param plan        the tech's plan, or null (no plan ⇒ $0 from the formula)
 * @param adjustments signed manual adjustment amounts (§4.7)
 */
export function computeCommission(
  jobs: EligibleJob[],
  plan: CommissionPlan | null,
  adjustments: number[] = [],
): CommissionResult {
  const effPlan: CommissionPlan = plan ?? { sales_target: 0, rate_below: 0, rate_above: 0 }
  // Adjustments are treated as received revenue ("fake already-received jobs"):
  // they count toward the target/tier and earn commission like real receipts.
  const adjustments_total = round2(adjustments.reduce((s, a) => s + a, 0))

  const received = ordered(jobs.filter(j => j.collected))
  const unpaid = ordered(jobs.filter(j => !j.collected))

  const realReceived = round2(received.reduce((s, j) => s + j.revenue, 0))
  const received_revenue = round2(realReceived + adjustments_total)
  const completed_revenue = round2(jobs.reduce((s, j) => s + j.revenue, 0))

  // Adjustment revenue sits at the bottom of the received stack; real received
  // jobs are positioned above it so they fill the tier accordingly.
  const base = Math.max(0, adjustments_total)
  let C = base
  const receivedLines: JobCommission[] = received.map(j => {
    const commission = marginal(C, j.revenue, effPlan)
    C += j.revenue
    return { sf_job_id: j.sf_job_id, revenue: j.revenue, commission, collected: true, projected: false }
  })

  // Projected commission for completed-but-unpaid jobs, layered above received.
  const unpaidLines: JobCommission[] = unpaid.map(j => {
    const commission = marginal(C, j.revenue, effPlan)
    C += j.revenue
    return { sf_job_id: j.sf_job_id, revenue: j.revenue, commission, collected: false, projected: true }
  })
  const cumulative_after_completed = C

  // Payout is the two-tier formula on total received revenue (incl. adjustments),
  // which is order-independent and therefore the source of truth.
  const commission_received = round2(commissionOnRevenue(Math.max(0, received_revenue), effPlan))
  const commission_pending = round2(unpaidLines.reduce((s, l) => s + l.commission, 0))

  return {
    received_revenue,
    completed_revenue,
    commission_received,
    commission_pending,
    adjustments_total,
    cumulative_after_completed,
    jobs: [...receivedLines, ...unpaidLines],
  }
}
