/**
 * Commission calculation engine (TRD §4).
 *
 * Pure functions — no I/O. Given a tech's eligible jobs for a period plus the
 * period's plan and any manual adjustments, compute the period rollup and each
 * job's per-job commission share. Because everything is a pure function of its
 * inputs, results are fully reproducible and auditable (§5.3).
 *
 * Two-tier formula on the PERIOD TOTAL (not per job) (§4.3):
 *   commission_earned = min(R, target)·rate_below + max(0, R−target)·rate_above
 *
 * Per-job share = each job's MARGINAL contribution in recognition-date order
 * (§4.5), so the shares sum exactly to commission_earned.
 */

export interface CommissionPlan {
  sales_target: number
  rate_below: number
  rate_above: number
}

export interface EligibleJob {
  sf_job_id: string
  /** 'YYYY-MM-DD' — drives ordering for the marginal split. */
  recognition_date: string
  /** Job total the commission is computed on (§4.2). */
  revenue: number
  /** True once the job is collected (linked invoice is_paid). Gates payout (§4.6). */
  collected: boolean
}

export interface JobCommission {
  sf_job_id: string
  revenue: number
  /** This job's marginal commission within the period. */
  commission: number
  collected: boolean
  /** commission if collected, else 0 (payout gated on collection). */
  payable: number
}

export interface CommissionResult {
  /** Sum of eligible revenue recognized in the period (R). */
  eligible_revenue: number
  /** Two-tier formula result on R (§4.3). */
  commission_earned: number
  /** Sum of collected jobs' commission + adjustments (§4.6, §4.7). */
  commission_payable: number
  /** Earned but not yet collected (commission_earned − collected portion). */
  commission_pending: number
  /** Signed manual adjustments total (§4.7). */
  adjustments_total: number
  /** Per-job breakdown, in recognition-date order. */
  jobs: JobCommission[]
}

/** Round to cents to avoid floating-point dust in stored/displayed figures. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/**
 * The two-tier commission on a period revenue total R (§4.3).
 * Exposed for the worked-example tests and the plan-screen live preview.
 */
export function commissionOnRevenue(R: number, plan: CommissionPlan): number {
  const { sales_target: target, rate_below, rate_above } = plan
  const below = Math.min(R, target) * rate_below
  const above = Math.max(0, R - target) * rate_above
  return round2(below + above)
}

/**
 * Order jobs for the marginal split: recognition date ascending, then sf_job_id
 * for deterministic tie-breaking (§4.5).
 */
function orderedForSplit(jobs: EligibleJob[]): EligibleJob[] {
  return [...jobs].sort((a, b) => {
    if (a.recognition_date !== b.recognition_date) {
      return a.recognition_date < b.recognition_date ? -1 : 1
    }
    return a.sf_job_id < b.sf_job_id ? -1 : a.sf_job_id > b.sf_job_id ? 1 : 0
  })
}

/**
 * Full period computation for one tech.
 *
 * @param jobs        the tech's eligible jobs for the period (status='eligible')
 * @param plan        the tech's plan for the period, or null (no plan ⇒ $0, §6)
 * @param adjustments signed manual adjustment amounts for the period (§4.7)
 */
export function computeCommission(
  jobs: EligibleJob[],
  plan: CommissionPlan | null,
  adjustments: number[] = [],
): CommissionResult {
  const adjustments_total = round2(adjustments.reduce((s, a) => s + a, 0))

  // No plan ⇒ the tech earns nothing from the formula this period (§6), but
  // adjustments still apply and revenue is still reported.
  const effectivePlan: CommissionPlan = plan ?? { sales_target: 0, rate_below: 0, rate_above: 0 }

  const ordered = orderedForSplit(jobs)
  const eligible_revenue = round2(ordered.reduce((s, j) => s + j.revenue, 0))

  // Marginal per-job split in recognition order (§4.5). Running cumulative C.
  const { sales_target: target, rate_below, rate_above } = effectivePlan
  let C = 0
  const jobLines: JobCommission[] = ordered.map(j => {
    const v = j.revenue
    const belowPortion = Math.max(0, Math.min(C + v, target) - C)
    const abovePortion = Math.max(0, C + v - Math.max(C, target))
    const commission = round2(belowPortion * rate_below + abovePortion * rate_above)
    C += v
    return {
      sf_job_id: j.sf_job_id,
      revenue: v,
      commission,
      collected: j.collected,
      payable: j.collected ? commission : 0,
    }
  })

  // Earned is the formula on the period total — the authoritative figure (§4.3).
  // Per-job shares sum to this (modulo cent rounding, reconciled below).
  const commission_earned = commissionOnRevenue(eligible_revenue, effectivePlan)

  // Reconcile rounding drift so the per-job shares sum exactly to earned: push
  // any residual onto the last job line.
  const lineSum = round2(jobLines.reduce((s, l) => s + l.commission, 0))
  const drift = round2(commission_earned - lineSum)
  if (drift !== 0 && jobLines.length > 0) {
    const last = jobLines[jobLines.length - 1]
    last.commission = round2(last.commission + drift)
    last.payable = last.collected ? last.commission : 0
  }

  const collectedCommission = round2(
    jobLines.reduce((s, l) => s + (l.collected ? l.commission : 0), 0),
  )

  // Payable = collected formula commission + adjustments (§4.6, §4.7).
  const commission_payable = round2(collectedCommission + adjustments_total)
  // Pending = earned but not yet collected (adjustments are immediately payable).
  const commission_pending = round2(commission_earned - collectedCommission)

  return {
    eligible_revenue,
    commission_earned,
    commission_payable,
    commission_pending,
    adjustments_total,
    jobs: jobLines,
  }
}
