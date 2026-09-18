// When each customer message is due. Pure — the sweep feeds it clock and row, tests feed it
// anything. All dates are PT calendar days (the workweek and every deadline in this app are
// America/Los_Angeles).
//
// Three sends, each stamped once, in order:
//   heads_up  — the morning of the scheduled date, from 8am PT: the link "so you have it".
//               Only for a job the OFFICE has marked "HD SOF Needed" in Service Fusion. That
//               marking is the authorisation, and it replaces the guessing this used to do
//               from the job's own status — which read "Door/Segment Installation" on a job
//               that had only had its site check.
//   ask       — the day after the date, if unsigned. Never the same PT day as the heads-up.
//   reminder  — three days after the ask, once, if still unsigned.
// "Never before the work is done" is what the wording carries; the link itself is never
// locked (owner's decision).

export type CustomerStage = 'heads_up' | 'ask' | 'reminder'

import type { SofStage } from './sub-status'

export interface DueInput {
  status: string
  created_at: string
  customer_sent_at: string | null
  customer_asked_at: string | null
  customer_reminded_at: string | null
  customer_signed_at: string | null
  /** The date of the work that matters (the install / delivery visit), YYYY-MM-DD, or null. */
  start_date: string | null
  /** Every date the job is on the books for — each visit's, plus the job's own. The heads-up
   *  goes out if ANY of them is today: a job can carry a site check, an install and a return
   *  trip at once, and the office marks "HD SOF Needed" for the one being worked. Falls back
   *  to start_date alone when no live read gave us the visits. */
  start_dates?: string[] | null
  /** Where the job's HD SOF sub-status stands, read live from SF. 'needed' is the office
   *  saying "send it"; anything else (including none) means no heads-up goes out. */
  sof?: SofStage | null
  /** When the extension last confirmed OUR own sub-status write. Cleared the moment a new
   *  write is queued, so the gap between sending and confirming can never be mistaken for
   *  the office asking again. */
  sub_status_set_at?: string | null
  /** The work is done (a visit's tech status Completed, or the job completed / invoiced / closed).
   *  undefined = not known (no live read) — then the ask waits. */
  completed?: boolean
  /** Setting cutoff: documents found before it are not auto-sent on their own — unless the
   *  office has marked the job HD SOF, or we have already written to this customer. */
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
/** Whole days since an instant, or null. Lives here rather than in the page because the
 *  React purity lint refuses a clock read during render, even in a server component. */
export function daysSinceIso(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now - t) / 86_400_000))
}

/** Whole PT calendar days from a to b (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86_400_000)
}

/** Why nothing is due — or which stage is. The sweep stores the reason on the document, so
 *  "why did this customer not get their form?" is answered by looking rather than by reading
 *  this file and guessing which gate fired. */
export interface StageDecision { stage: CustomerStage | null; reason: string }

export function customerStageDue(d: DueInput): CustomerStage | null {
  return decideCustomerStage(d).stage
}

export function decideCustomerStage(d: DueInput): StageDecision {
  if (!['prepared', 'sent_customer'].includes(d.status)) return no(`document status is "${d.status}" — only a prepared form can be sent`)
  if (d.customer_signed_at) return no('the customer has already signed')
  if (!d.enabled_at) return no('auto-send is off')
  // The cutoff exists so that switching auto-send on does not mail the ~200 blanks already
  // sitting on file. A job the office has marked HD SOF is not one of those: someone chose
  // it deliberately, and that choice is a far better gate than when the blank happened to be
  // captured. Job 1020258680 was captured on 9 Sep, auto-send went on late on 14 Sep, and
  // the marking at 7:53 the next morning could never release it.
  // The same applies once we have written to this customer at all: the ask and the reminder
  // have to be able to follow their own heads-up.
  if (d.created_at < d.enabled_at && !d.sof && !d.customer_sent_at) return no('the blank was captured before auto-send was switched on, and the job is not marked HD SOF')
  // The work is done: ask now, whether or not a heads-up ever went out (the link goes with it).
  if (!d.customer_asked_at && d.completed === true) {
    if (d.customer_sent_at && ptDay(d.customer_sent_at) >= d.today && d.hour < 17) return no('the heads-up went out this morning — the ask waits until 5pm')
    return yes('ask', 'the work is done and nothing has been asked yet')
  }
  if (!d.customer_sent_at) {
    // Nothing reaches a customer on a job the office has not marked "HD SOF Needed".
    if (d.sof !== 'needed') return no(`the job's HD SOF sub-status is ${d.sof ? `"${d.sof}"` : 'not set'} — the office has not asked for the form`)
    const dates = (d.start_dates?.length ? d.start_dates : d.start_date ? [d.start_date] : [])
    if (!dates.length) return no('the job has no work date')
    const onToday = dates.find(x => daysBetween(x, d.today) === 0)
    if (!onToday) {
      const near = [...dates].sort((a, b) => Math.abs(daysBetween(a, d.today)) - Math.abs(daysBetween(b, d.today)))[0]
      const away = daysBetween(near, d.today)
      return no(`nothing is scheduled today — ${dates.length > 1 ? `this job's dates are ${dates.join(', ')}; the nearest` : 'the work date'} is ${near}, ${away > 0 ? `${away} day(s) ago` : `in ${-away} day(s)`}`)
    }
    if (d.hour < 8) return no(`it is ${d.hour}:00 PT — the heads-up waits for 8am`)
    return yes('heads_up', `a visit is scheduled today (${onToday}) and the office has marked HD SOF Needed`)
  }
  // Back on "HD SOF Needed" after we set "HD SOF Sent": the office is asking for it again.
  // Gated on our write having been CONFIRMED, so an in-flight write is not a second send.
  if (d.sof === 'needed' && d.sub_status_set_at) return yes('heads_up', 'the office put the job back on HD SOF Needed')
  const rel = d.start_date ? daysBetween(d.start_date, d.today) : 0   // 0 = the day itself, >0 = days after
  if (!d.customer_asked_at) {
    // No completion signal available (no live read): fall back to the day after the date.
    if (d.completed === undefined && d.start_date && rel >= 1 && ptDay(d.customer_sent_at) < d.today) return yes('ask', 'no live read, so the ask falls back to the day after the work date')
    return no(d.completed === false ? 'the work is not finished yet' : 'nothing is due yet')
  }
  if (!d.customer_reminded_at) {
    const since = daysBetween(ptDay(d.customer_asked_at), d.today)
    return since >= 3 ? yes('reminder', 'three days since the ask and still unsigned') : no(`asked ${since} day(s) ago — the reminder waits for three`)
  }
  return no('the heads-up, the ask and the reminder have all gone out')
}

const no = (reason: string): StageDecision => ({ stage: null, reason })
const yes = (stage: CustomerStage, reason: string): StageDecision => ({ stage, reason })
