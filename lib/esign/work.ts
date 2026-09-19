import type { LiveJobFacts } from '@/lib/agent/live-refresh'
import { isCompletedish } from '@/lib/sf-mirror/completion-status'
import type { TemplateService } from './templates'

// What stage the WORK is at, read from the live SF job — the thing the e-sign timing must
// key on. A Clopay install is two visits on one job: a site check (category "CLOPAY:
// Inspection", visit notes "Site Check" / "site inspection") and later the install
// (category "CLOPAY: Door/Segment Installation"). SF keeps one visit at a time, and the
// mirror's job date is often null or the site-check date, so the job's `start_date` alone
// would send the form on the wrong day. Seen on real jobs 2026-09-12:
//   1020256603  Inspection, visit 08-25 "site inspection"       → inspection, not done
//   1020259141  Inspection, visit 09-09 "Site Check"            → inspection, not done
//   1020259079  Door/Segment Installation, visit 08-27          → install, date 08-27, not done
//   1020258612  Invoiced, closed, visit tech status "Completed" → install, done

export type WorkPhase = 'inspection' | 'waiting' | 'install' | 'delivery' | 'unknown'
export interface WorkState {
  phase: WorkPhase
  /** The date of the visit that matters (the latest one), YYYY-MM-DD. */
  workDate: string | null
  /** EVERY date this job is on the books for — each visit's, plus the job's own — oldest
   *  first. A job can carry several visits at once (a site check, an install, a return trip),
   *  and the office marks "HD SOF Needed" for whichever one is happening: keying only on the
   *  latest would hold the form back on the day a customer is actually being visited. */
  workDates: string[]
  /** The work is done: a visit's tech status says Completed, or the job is completed / invoiced / closed. */
  completed: boolean
  detail: string
}

const INSPECTION = /inspection|site\s*check|measure/i
const INSTALL = /install/i
// A job parked on a waiting status has NOT had its install scheduled, whatever the category
// or the visit says: 1020259079 read "Door/Segment Installation" with a visit on the books
// and was still only the site check ("Waiting on Clopay"). Nothing goes out on these.
export const WAITING = /waiting|pending|on\s*hold|hold\b|unscheduled|need|awaiting/i

export function deriveWork(f: LiveJobFacts, service: TemplateService): WorkState {
  const latest = [...f.visits].sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''))[0] ?? null
  const workDate = (latest?.startDate ?? f.startDate ?? null)?.slice(0, 10) ?? null
  const workDates = [...new Set([...f.visits.map(v => v.startDate), f.startDate]
    .map(d => d?.slice(0, 10) ?? null)
    .filter((d): d is string => !!d))].sort()
  // Completion comes from the job, or from the LAST visit — never from "any visit". A tech
  // marking one trip complete says that trip is over, not that the job is: 1020259275 had
  // 09-17 "Completed" with 09-18 still "Scheduled", which under `some()` read as finished
  // work and would have asked the customer to sign off an install that had not happened.
  // (Castle's techs also use "DONE" for "my visit is over, whatever the outcome" —
  // 1020258541's techs marked DONE on a visit whose note reads "Installation Attempt
  // Failed" — so DONE deliberately does NOT count as completion.)
  const lastVisit = f.visits.length ? f.visits[f.visits.length - 1] : null
  const completed = !!f.completedAt || isCompletedish(f.status) || isCompletedish(lastVisit?.techStatus)
  const cat = f.category ?? ''
  let phase: WorkPhase = 'unknown'
  if (completed) phase = service === 'delivery' ? 'delivery' : 'install'
  else if (WAITING.test(f.status ?? '')) phase = 'waiting'
  else if (service === 'delivery') phase = 'delivery'
  else if (INSPECTION.test(cat) || INSPECTION.test(latest?.notes ?? '')) phase = 'inspection'
  else if (INSTALL.test(cat) || INSTALL.test(latest?.notes ?? '') || INSTALL.test(f.description ?? '')) phase = 'install'
  const detail = [
    cat ? `category "${cat}"` : 'no category',
    latest ? `visit ${latest.startDate ?? '?'}${latest.notes ? ` "${latest.notes.split(/\r?\n/)[0].slice(0, 40)}"` : ''}${latest.techStatus ? ` (${latest.techStatus})` : ''}` : 'no visit',
    `job status "${f.status ?? '?'}"`,
  ].join(' · ')
  return { phase, workDate, workDates, completed, detail }
}
