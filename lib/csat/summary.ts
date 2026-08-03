// Pure CSAT roll-up — safe to import from client components (no I/O).

export interface RatingSummary {
  /** CSAT% = (ratings of 4 or 5) / valid × 100, rounded; null when no responses. */
  csat: number | null
  /** Mean of valid ratings; null when none. */
  average: number | null
  /** Count of valid (parsed) ratings behind these numbers — always surface this. */
  responses: number
  count5: number
  count4: number
  countLow: number // 1–3
  /** rating → count, keys "1".."5". */
  distribution: Record<string, number>
}

/** Pure roll-up of a list of 1–5 ratings. */
export function summarizeRatings(ratings: number[]): RatingSummary {
  const valid = ratings.filter(r => r >= 1 && r <= 5)
  const responses = valid.length
  const distribution: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }
  for (const r of valid) distribution[String(r)]++
  const count5 = distribution['5']
  const count4 = distribution['4']
  const countLow = distribution['1'] + distribution['2'] + distribution['3']
  const satisfied = count5 + count4
  return {
    csat: responses ? Math.round((satisfied / responses) * 100) : null,
    average: responses ? valid.reduce((s, r) => s + r, 0) / responses : null,
    responses,
    count5,
    count4,
    countLow,
    distribution,
  }
}
