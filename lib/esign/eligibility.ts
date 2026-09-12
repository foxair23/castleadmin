// When each customer message is due. Pure — the sweep feeds it clock and row, tests feed it
// anything. All dates are PT calendar days (the workweek and every deadline in this app are
// America/Los_Angeles).
//
// Three sends, each stamped once, in order:
//   heads_up  — the morning of the install/delivery, from 8am PT: the link "so you have it".
//               A job whose date is already past when we first see it gets this on the
//               next sweep instead (never skipped: the customer must have the link).
//   ask       — the day after the date, if unsigned. Never the same PT day as the heads-up.
//   reminder  — three days after the ask, once, if still unsigned.
// "Never before the work is done" is what the wording carries; the link itself is never
// locked (owner's decision).

export type CustomerStage = 'heads_up' | 'ask' | 'reminder'

export type WorkPhase = 'inspection' | 'install' | 'delivery' | 'unknown'

export interface DueInput {
  status: string
  created_at: string
  customer_sent_at: string | null
  customer_asked_at: string | null
  customer_reminded_at: string | null
  customer_signed_at: string | null
  /** The date of the work that matters (the install / delivery visit), YYYY-MM-DD, or null. */
  start_date: string | null
  /** What the job is at, read live from SF. 'inspection' = the site check; nothing is sent. */
  phase?: WorkPhase
  /** The work is done (a visit's tech status Completed, or the job completed / invoiced / closed).
   *  undefined = not known (no live read) — then the ask waits. */
  completed?: boolean
  /** Setting cutoff; documents found before it are never auto-sent. */
  enabled_at: string | null
  /** The sweep's clock, PT: calendar day YYYY-MM-DD and hour 0–23. */
  today: string
  hour: number
}

const TZ = 'America/Los_Angeles'
export function ptDay(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}
export function ptHour(d: Date = new Date()): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }).format(d).replace(/[^0-9]/g, '')) % 24
}
/** Whole PT calendar days from a to b (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86_400_000)
}

export function customerStageDue(d: DueInput): CustomerStage | null {
  if (!['prepared', 'sent_customer'].includes(d.status)) return null
  if (d.customer_signed_at) return null
  if (!d.enabled_at || d.created_at < d.enabled_at) return null
  // A site check is not the work. Nothing goes out until the job is at the install.
  if (d.phase === 'inspection') return null
  // The work is done: ask now, whether or not a heads-up ever went out (the link goes with it).
  if (!d.customer_asked_at && d.completed === true) {
    if (d.customer_sent_at && ptDay(d.customer_sent_at) >= d.today && d.hour < 17) return null   // heads-up went this morning; give the day
    return 'ask'
  }
  if (!d.start_date) return null
  const rel = daysBetween(d.start_date, d.today)          // 0 = the day itself, >0 = days after
  if (!d.customer_sent_at) {
    if (rel === 0 && d.hour >= 8) return 'heads_up'        // the morning of the work
    return null                                            // before the day, or the day has passed without completion: wait
  }
  if (!d.customer_asked_at) {
    // No completion signal available (no live read): fall back to the day after the date.
    if (d.completed === undefined && rel >= 1 && ptDay(d.customer_sent_at) < d.today) return 'ask'
    return null
  }
  if (!d.customer_reminded_at) {
    return daysBetween(ptDay(d.customer_asked_at), d.today) >= 3 ? 'reminder' : null
  }
  return null
}
