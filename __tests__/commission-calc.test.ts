/**
 * Commission calc engine tests (TRD §10, acceptance criteria 6 & 7).
 *
 * Verifies:
 *   • the three worked examples in §4.3 ($1,750 / $700 / $1,015)
 *   • per-job marginal shares sum exactly to commission_earned (§4.5), including
 *     a job that straddles the target
 *   • payout gating on collection (§4.6) and manual adjustments (§4.7)
 *   • no-plan periods earn nothing (§6)
 */

import { describe, it, expect } from 'vitest'
import {
  computeCommission,
  commissionOnRevenue,
  type CommissionPlan,
  type EligibleJob,
} from '@/lib/commission/calc'

const PLAN: CommissionPlan = { sales_target: 10000, rate_below: 0.1, rate_above: 0.15 }

function job(id: string, date: string, revenue: number, collected = true): EligibleJob {
  return { sf_job_id: id, recognition_date: date, revenue, collected }
}

describe('commissionOnRevenue — §4.3 worked examples', () => {
  it('R = 15,000 → 1,750', () => {
    expect(commissionOnRevenue(15000, PLAN)).toBe(1750)
  })
  it('R = 7,000 → 700', () => {
    expect(commissionOnRevenue(7000, PLAN)).toBe(700)
  })
  it('R = 10,100 → 1,015', () => {
    expect(commissionOnRevenue(10100, PLAN)).toBe(1015)
  })
  it('R exactly at target → target × rate_below', () => {
    expect(commissionOnRevenue(10000, PLAN)).toBe(1000)
  })
})

describe('computeCommission — period rollup', () => {
  it('matches the §4.3 examples at the period level', () => {
    const r1 = computeCommission([job('a', '2026-07-01', 15000)], PLAN)
    expect(r1.commission_earned).toBe(1750)

    const r2 = computeCommission([job('b', '2026-07-01', 7000)], PLAN)
    expect(r2.commission_earned).toBe(700)

    const r3 = computeCommission([job('c', '2026-07-01', 10100)], PLAN)
    expect(r3.commission_earned).toBe(1015)
  })

  it('tiers on the period total, not per job (order independent)', () => {
    const jobs = [
      job('a', '2026-07-03', 4000),
      job('b', '2026-07-01', 5000),
      job('c', '2026-07-02', 6000),
    ]
    // R = 15,000 → same as the single 15k job.
    const res = computeCommission(jobs, PLAN)
    expect(res.eligible_revenue).toBe(15000)
    expect(res.commission_earned).toBe(1750)
  })
})

describe('computeCommission — per-job marginal split (§4.5, criterion 7)', () => {
  it('per-job shares sum exactly to commission_earned', () => {
    const jobs = [
      job('a', '2026-07-01', 5000),
      job('b', '2026-07-02', 6000),  // straddles the 10k target (5k→11k)
      job('c', '2026-07-03', 4000),
    ]
    const res = computeCommission(jobs, PLAN)
    const sum = res.jobs.reduce((s, j) => s + j.commission, 0)
    expect(Number(sum.toFixed(2))).toBe(res.commission_earned)
  })

  it('the straddling job splits across both tiers correctly', () => {
    // C starts at 5000; job b is 6000 → 5000..10000 at 10% (5000) + 10000..11000 at 15% (1000).
    const jobs = [
      job('a', '2026-07-01', 5000),
      job('b', '2026-07-02', 6000),
    ]
    const res = computeCommission(jobs, PLAN)
    const b = res.jobs.find(j => j.sf_job_id === 'b')!
    // below: 5000 × 0.10 = 500 ; above: 1000 × 0.15 = 150 → 650
    expect(b.commission).toBe(650)
    const a = res.jobs.find(j => j.sf_job_id === 'a')!
    expect(a.commission).toBe(500) // 5000 × 0.10
  })

  it('orders by recognition date then job id for the split', () => {
    // Same revenues, deliberately unsorted input — result must be deterministic.
    const jobs = [
      job('z', '2026-07-02', 6000),
      job('a', '2026-07-01', 5000),
      job('m', '2026-07-02', 4000),
    ]
    const res = computeCommission(jobs, PLAN)
    // a (07-01) first; then the 07-02 pair tie-broken by job id: m < z.
    expect(res.jobs.map(j => j.sf_job_id)).toEqual(['a', 'm', 'z'])
  })
})

describe('computeCommission — payout gating (§4.6) & adjustments (§4.7)', () => {
  it('only collected jobs contribute to payable; rest are pending', () => {
    const jobs = [
      job('a', '2026-07-01', 5000, true),   // collected
      job('b', '2026-07-02', 5000, false),  // not collected
    ]
    const res = computeCommission(jobs, PLAN)
    // R = 10,000 → earned 1,000. Each 5k job earns 500.
    expect(res.commission_earned).toBe(1000)
    expect(res.commission_payable).toBe(500)   // only job a
    expect(res.commission_pending).toBe(500)   // job b
  })

  it('adjustments affect payable and are reported separately', () => {
    const jobs = [job('a', '2026-07-01', 5000, true)]
    const res = computeCommission(jobs, PLAN, [-100, 50])
    expect(res.adjustments_total).toBe(-50)
    // collected commission 500 + (−50) adjustment = 450 payable
    expect(res.commission_payable).toBe(450)
  })
})

describe('computeCommission — no plan (§6)', () => {
  it('earns nothing from the formula but still reports revenue and adjustments', () => {
    const jobs = [job('a', '2026-07-01', 5000, true)]
    const res = computeCommission(jobs, null, [25])
    expect(res.eligible_revenue).toBe(5000)
    expect(res.commission_earned).toBe(0)
    expect(res.commission_payable).toBe(25) // adjustment only
    expect(res.commission_pending).toBe(0)
  })
})
