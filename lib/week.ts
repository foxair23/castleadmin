// All week calculations in America/Los_Angeles timezone

const TZ = 'America/Los_Angeles'

/** Returns the Monday of the week containing the given date, as YYYY-MM-DD */
export function getWeekStart(date: Date = new Date()): string {
  const la = new Date(date.toLocaleString('en-US', { timeZone: TZ }))
  const day = la.getDay() // 0=Sun, 1=Mon, ..., 6=Sat
  const diff = day === 0 ? -6 : 1 - day
  la.setDate(la.getDate() + diff)
  return formatDate(la)
}

/** Returns the Sunday of the week starting on the given Monday (YYYY-MM-DD) */
export function getWeekEnd(weekStart: string): string {
  const d = parseDate(weekStart)
  d.setDate(d.getDate() + 6)
  return formatDate(d)
}

/**
 * Returns the submission deadline for a workweek:
 * Wednesday 23:59 of the FOLLOWING week.
 */
export function getSubmissionDeadline(weekStart: string): Date {
  const d = parseDate(weekStart)
  // weekStart is Monday; next Wednesday = +9 days
  d.setDate(d.getDate() + 9)
  // Set to 23:59:59 LA time — build as string for Date constructor
  const dateStr = `${formatDate(d)}T23:59:59`
  // Create Date in LA timezone
  return new Date(
    new Date(dateStr).toLocaleString('en-US', { timeZone: 'UTC' })
  )
}

/** True when the submission deadline for this week has passed */
export function isDeadlinePassed(weekStart: string): boolean {
  const deadline = getDeadlineForWeek(weekStart)
  const nowLA = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }))
  return nowLA > deadline
}

/** Deadline as a plain Date (treated as LA time internally) */
export function getDeadlineForWeek(weekStart: string): Date {
  const d = parseDate(weekStart)
  d.setDate(d.getDate() + 9) // Monday + 9 = next Wednesday
  d.setHours(23, 59, 59, 999)
  return d
}

/** Format a Date as YYYY-MM-DD */
export function formatDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Parse YYYY-MM-DD string to a local Date object */
export function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** Human-friendly label: "Mon May 5 – Sun May 11, 2025" */
export function weekLabel(weekStart: string): string {
  const start = parseDate(weekStart)
  const end = parseDate(getWeekEnd(weekStart))
  const fmt = (d: Date) =>
    d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  return `${fmt(start)} – ${fmt(end)}, ${end.getFullYear()}`
}

/** Returns list of recent Monday dates (YYYY-MM-DD) for week selector */
export function recentWeeks(count = 8): string[] {
  const weeks: string[] = []
  const current = getWeekStart()
  const d = parseDate(current)
  for (let i = 0; i < count; i++) {
    weeks.push(formatDate(d))
    d.setDate(d.getDate() - 7)
  }
  return weeks
}

/** Calculate pay for a work item */
export function calculateItemPay(
  baseRate: number,
  additionalRate: number | null,
  requiresQuantity: boolean,
  quantity: number
): number {
  if (!requiresQuantity) return baseRate
  if (quantity <= 0) return 0
  return baseRate + Math.max(0, quantity - 1) * (additionalRate ?? 0)
}

/** Format dollars */
export function formatMoney(amount: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount)
}
