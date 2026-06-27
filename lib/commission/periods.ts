/**
 * Commission period engine (TRD §6).
 *
 * Periods are generic over a `PeriodType`. Monthly is active now; quarterly is
 * fully supported so switching is a config change, not a rewrite. All period
 * math is on calendar boundaries in America/Los_Angeles (the app's workweek
 * timezone). The first commission period begins on COMMISSION_START_DATE; jobs
 * recognized before it are ignored entirely (§3.5).
 *
 * Dates are handled as plain 'YYYY-MM-DD' strings to avoid UTC/local drift —
 * a recognition date is a calendar day in PT, not an instant.
 */

export type PeriodType = 'monthly' | 'quarterly'

export interface Period {
  type: PeriodType
  /** inclusive 'YYYY-MM-DD' */
  start: string
  /** inclusive 'YYYY-MM-DD' */
  end: string
  /** stable key, e.g. '2026-07' (monthly) or '2026-Q3' (quarterly) */
  key: string
  /** human label, e.g. 'July 2026' or 'Q3 2026' */
  label: string
}

/** The active period type. Flip to 'quarterly' to switch the whole module. */
export const ACTIVE_PERIOD_TYPE: PeriodType = 'monthly'

/** No job recognized before this date is ever commission-eligible (§3.5). */
export const COMMISSION_START_DATE = '2026-06-22'

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** Parse 'YYYY-MM-DD' (or a longer ISO string) into numeric Y/M/D parts. */
function parseYmd(d: string): { y: number; m: number; d: number } {
  const [y, m, day] = d.slice(0, 10).split('-').map(Number)
  return { y, m, d: day }
}

/** Last calendar day of a given 1-based month, accounting for leap years. */
function lastDayOfMonth(year: number, month1: number): number {
  // Day 0 of the next month is the last day of this month.
  return new Date(Date.UTC(year, month1, 0)).getUTCDate()
}

/** The 1-based quarter (1–4) for a 1-based month. */
function quarterOfMonth(month1: number): number {
  return Math.floor((month1 - 1) / 3) + 1
}

/**
 * The full (un-clamped) period containing the given date, for a period type.
 * Monthly → that calendar month. Quarterly → that calendar quarter.
 */
export function periodForDate(date: string, type: PeriodType = ACTIVE_PERIOD_TYPE): Period {
  const { y, m } = parseYmd(date)

  if (type === 'monthly') {
    const start = `${y}-${pad2(m)}-01`
    const end = `${y}-${pad2(m)}-${pad2(lastDayOfMonth(y, m))}`
    return { type, start, end, key: `${y}-${pad2(m)}`, label: `${MONTH_NAMES[m - 1]} ${y}` }
  }

  // quarterly
  const q = quarterOfMonth(m)
  const startMonth = (q - 1) * 3 + 1
  const endMonth = startMonth + 2
  const start = `${y}-${pad2(startMonth)}-01`
  const end = `${y}-${pad2(endMonth)}-${pad2(lastDayOfMonth(y, endMonth))}`
  return { type, start, end, key: `${y}-Q${q}`, label: `Q${q} ${y}` }
}

/**
 * The period a recognition date belongs to, with the first period clamped so it
 * never starts before COMMISSION_START_DATE. Returns null if the date is before
 * the start date (not commission-eligible at all).
 */
export function periodForRecognitionDate(
  date: string,
  type: PeriodType = ACTIVE_PERIOD_TYPE,
): Period | null {
  const day = date.slice(0, 10)
  if (day < COMMISSION_START_DATE) return null
  const p = periodForDate(day, type)
  // Clamp the very first period's start so June 2026 runs 06-22 → 06-30.
  if (p.start < COMMISSION_START_DATE) {
    return { ...p, start: COMMISSION_START_DATE }
  }
  return p
}

/** Advance to the period immediately after the given one. */
export function nextPeriod(p: Period): Period {
  // A day past the end lands in the next period; re-derive (and re-clamp).
  const { y, m, d } = parseYmd(p.end)
  const dayAfter = new Date(Date.UTC(y, m - 1, d + 1))
  const ymd = `${dayAfter.getUTCFullYear()}-${pad2(dayAfter.getUTCMonth() + 1)}-${pad2(dayAfter.getUTCDate())}`
  return periodForRecognitionDate(ymd, p.type) ?? periodForDate(ymd, p.type)
}

/**
 * Enumerate every period from COMMISSION_START_DATE through the period
 * containing `throughDate`, oldest first. Used to build period selectors.
 */
export function listPeriods(
  throughDate: string,
  type: PeriodType = ACTIVE_PERIOD_TYPE,
): Period[] {
  const last = periodForDate(throughDate.slice(0, 10), type)
  const out: Period[] = []
  let cur = periodForRecognitionDate(COMMISSION_START_DATE, type)!
  // Compare against last.end, not last.start: the first period's start is
  // clamped forward (e.g. 2026-06-22), so comparing clamped starts would wrongly
  // exclude the current period when today falls inside that first clamped month.
  // Guard against runaway loops; 50 years of quarters is well beyond any real use.
  for (let i = 0; i < 1000 && cur.start <= last.end; i++) {
    out.push(cur)
    cur = nextPeriod(cur)
  }
  return out
}

/** True if a recognition date falls within a period (inclusive). */
export function dateInPeriod(date: string, p: Period): boolean {
  const day = date.slice(0, 10)
  return day >= p.start && day <= p.end
}
