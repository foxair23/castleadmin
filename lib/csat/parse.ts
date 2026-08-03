// CSAT rating parsing + classification — pure functions (unit-tested, no I/O).
//
// PRD §8: extract a rating only when the message contains exactly one
// unambiguous integer from 1–5. A message with no number, an out-of-range
// number (e.g. "10"), or two different numbers (e.g. "4 or 5") is ambiguous and
// gets a one-time clarification, not a recorded rating.

export type Classification = 'high' | 'satisfied' | 'low' | 'invalid'

/**
 * Parse a single unambiguous 1–5 rating from an SMS reply, or null.
 *
 * Rules:
 *  - Collect every maximal run of digits in the message.
 *  - Any run that isn't a single 1–5 digit (e.g. "10", "42", "0") makes the
 *    message ambiguous → null.
 *  - If the distinct set of 1–5 values has exactly one member → that rating.
 *  - Otherwise (none, or several different values like "4 or 5") → null.
 *
 * Note: a hedged single number like "Maybe a 3" resolves to 3 — we prefer to
 * capture a clear single rating rather than over-reject genuine feedback.
 */
export function parseRating(text: string): number | null {
  if (!text) return null
  const runs = text.match(/\d+/g)
  if (!runs || runs.length === 0) return null

  const values = new Set<number>()
  for (const run of runs) {
    // An out-of-range or multi-digit number is a signal we can't trust the reply.
    if (run.length !== 1) return null
    const n = Number(run)
    if (n < 1 || n > 5) return null
    values.add(n)
  }
  if (values.size !== 1) return null
  return [...values][0]
}

/** Classify a (possibly null) rating into the reporting bucket. */
export function classify(rating: number | null): Classification {
  if (rating === 5) return 'high'
  if (rating === 4) return 'satisfied'
  if (rating === 1 || rating === 2 || rating === 3) return 'low'
  return 'invalid'
}

/** A rating of 1–3 requires follow-up / recovery. */
export function isLow(rating: number | null): boolean {
  return rating != null && rating >= 1 && rating <= 3
}
