/**
 * Commission calc engine tests (revised model).
 *
 * Tier and commission are measured on RECEIVED (collected) revenue. Completed-
 * but-unpaid jobs show a projection layered on top of the received total. Period
 * attribution (completion month) lives in the engine, not here.
 */

import { describe, it, expect } from 'vitest'
import {
  computeCommission,
  commissionOnRevenue,
  marginal,
  type CommissionPlan,
  type EligibleJob,
} from '@/lib/commission/calc'

const PLAN: CommissionPlan = { sales_target: 10000, rate_below: 0.1, rate_above: 0.15 }

function job(id: string, date: string, revenue: number, collected: boolean): EligibleJob {
  return { sf_job_id: id, recognition_date: date, revenue, collected }
}

describe('commissionOnRevenue — two-tier formula (§4.3 worked examples)', () => {
  it('R = 15,000 → 1,750', () => expect(commissionOnRevenue(15000, PLAN)).toBe(1750))
  it('R = 7,000 → 700', () => expect(commissionOnRevenue(7000, PLAN)).toBe(700))
  it('R = 10,100 → 1,015', () => expect(commissionOnRevenue(10100, PLAN)).toBe(1015))
  it('R at target → target × rate_below', () => expect(commissionOnRevenue(10000, PLAN)).toBe(1000))
})

describe('marginal', () => {
  it('splits a span across the target', () => {
    // 5000..11000 → 5000 below (10%) + 1000 above (15%) = 500 + 150 = 650
    expect(marginal(5000, 6000, PLAN)).toBe(650)
  })
})

describe('computeCommission — tier on RECEIVED revenue', () => {
  it('all jobs received → commission on the full received total', () => {
    const jobs = [
      job('a', '2026-07-01', 8000, true),
      job('b', '2026-07-02', 7000, true),
    ]
    const res = computeCommission(jobs, PLAN)
    expect(res.received_revenue).toBe(15000)
    expect(res.commission_received).toBe(1750)
    expect(res.commission_pending).toBe(0)
  })

  it('only received revenue counts toward the tier; unpaid is projected', () => {
    const jobs = [
      job('a', '2026-07-01', 8000, true),   // received
      job('b', '2026-07-02', 7000, false),  // completed, not paid
    ]
    const res = computeCommission(jobs, PLAN)
    // received 8,000 → all below target → 800
    expect(res.received_revenue).toBe(8000)
    expect(res.commission_received).toBe(800)
    // b projected from C=8000: 8000..15000 → 2000 below (200) + 5000 above (750) = 950
    expect(res.commission_pending).toBe(950)
    expect(res.completed_revenue).toBe(15000)
  })

  it('higher tier only kicks in once received revenue passes target', () => {
    // Same two jobs, both received → now the above-target portion is real.
    const jobs = [
      job('a', '2026-07-01', 8000, true),
      job('b', '2026-07-02', 7000, true),
    ]
    const res = computeCommission(jobs, PLAN)
    const b = res.jobs.find(j => j.sf_job_id === 'b')!
    // b spans 8000..15000 → 2000 below (200) + 5000 above (750) = 950, now REAL
    expect(b.commission).toBe(950)
    expect(b.projected).toBe(false)
  })

  it('received per-job commissions sum exactly to commission on received revenue', () => {
    const jobs = [
      job('a', '2026-07-01', 5000, true),
      job('b', '2026-07-02', 6000, true), // straddles target
      job('c', '2026-07-03', 4000, true),
    ]
    const res = computeCommission(jobs, PLAN)
    const sum = res.jobs.filter(j => j.collected).reduce((s, j) => s + j.commission, 0)
    expect(Number(sum.toFixed(2))).toBe(commissionOnRevenue(res.received_revenue, PLAN))
  })

  it('adjustments add to commission_received', () => {
    const jobs = [job('a', '2026-07-01', 5000, true)]
    const res = computeCommission(jobs, PLAN, [-100, 50])
    expect(res.adjustments_total).toBe(-50)
    expect(res.commission_received).toBe(450) // 500 − 50
  })

  it('no plan → nothing from the formula, adjustments still apply', () => {
    const jobs = [job('a', '2026-07-01', 5000, true)]
    const res = computeCommission(jobs, null, [25])
    expect(res.received_revenue).toBe(5000)
    expect(res.commission_received).toBe(25)
    expect(res.commission_pending).toBe(0)
  })

  it('nothing received yet → all pending, nothing payable', () => {
    const jobs = [
      job('a', '2026-07-01', 5000, false),
      job('b', '2026-07-02', 6000, false),
    ]
    const res = computeCommission(jobs, PLAN)
    expect(res.received_revenue).toBe(0)
    expect(res.commission_received).toBe(0)
    // projected on the full 11,000: 10,000 below (1000) + 1000 above (150) = 1150
    expect(res.commission_pending).toBe(1150)
  })
})
