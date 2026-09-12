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

export type WorkPhase = 'inspection' | 'install' | 'delivery' | 'unknown'
export interface WorkState {
  phase: WorkPhase
  /** The date of the visit that matters (the latest one), YYYY-MM-DD. */
  workDate: string | null
  /** The work is done: a visit's tech status says Completed, or the job is completed / invoiced / closed. */
  completed: boolean
  detail: string
}

const INSPECTION = /inspection|site\s*check|measure/i
const INSTALL = /install/i

export function deriveWork(f: LiveJobFacts, service: TemplateService): WorkState {
  const latest = [...f.visits].sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''))[0] ?? null
  const workDate = (latest?.startDate ?? f.startDate ?? null)?.slice(0, 10) ?? null
  const completed = !!f.completedAt || isCompletedish(f.status) || f.visits.some(v => isCompletedish(v.techStatus))
  const cat = f.category ?? ''
  let phase: WorkPhase = 'unknown'
  if (service === 'delivery') phase = 'delivery'
  else if (INSPECTION.test(cat) || (!INSTALL.test(cat) && latest?.notes && INSPECTION.test(latest.notes))) phase = 'inspection'
  else if (INSTALL.test(cat) || INSTALL.test(latest?.notes ?? '') || INSTALL.test(f.description ?? '') || completed) phase = 'install'
  const detail = [
    cat ? `category "${cat}"` : 'no category',
    latest ? `visit ${latest.startDate ?? '?'}${latest.notes ? ` "${latest.notes.split(/\r?\n/)[0].slice(0, 40)}"` : ''}${latest.techStatus ? ` (${latest.techStatus})` : ''}` : 'no visit',
    `job status "${f.status ?? '?'}"`,
  ].join(' · ')
  return { phase, workDate, completed, detail }
}
