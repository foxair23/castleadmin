import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentSettings, QuestionType } from '@/lib/agent/settings'
import { resolveJob, type ResolveResult, type ResolverIdentifiers } from '@/lib/agent/job-resolver'
import { refreshJob, type LiveJobFacts, type LiveRefreshResult } from '@/lib/agent/live-refresh'
import { listAnswers, type AnswerEntry } from '@/lib/agent/knowledge'

// Stage 3b — gather everything the composer is ALLOWED to say (PRD §5, §6.4, §9.3).
// Output is a numbered list of facts. The composer must cite fact ids; the grounding
// check (grounding-check.ts) then verifies every concrete value in the reply appears
// in a cited fact. Nothing reaches the composer that is not in this pack.

export interface Fact {
  id: string                       // F1, F2, ...
  source: 'sf_job' | 'vendor_order' | 'answer_library' | 'resolver' | 'chat_answer'
  refId: string | null
  label: string                    // "Job 1020259225 · schedule"
  /** The text the composer sees. Written as plain statements. */
  text: string
  /** Raw values the grounding check may match against (dates, names, numbers). */
  values: string[]
}

export interface GroundingPack {
  resolve: ResolveResult
  live: LiveRefreshResult | null
  facts: Fact[]
  answers: AnswerEntry[]
  vendor: VendorContext | null
  /** Why grounding is incomplete, in plain words, for the reviewer. */
  gaps: string[]
}

export interface VendorContext {
  vendor: string
  externalId: string
  status: string | null
  nextStep: string | null
  dcReservedAt: string | null
  detailsReceivedAt: string | null
  scheduleDate: string | null
  storeNumber: string | null
}

const PT = 'America/Los_Angeles'

/** SF's 'YYYY-MM-DD HH:mm:ss' (already PT) or ISO → "Tuesday, September 8" and "8:00 AM". */
export function fmtDay(s: string | null): string | null {
  if (!s) return null
  const d = parseSf(s); if (!d) return null
  return d.toLocaleDateString('en-US', { timeZone: PT, weekday: 'long', month: 'long', day: 'numeric' })
}
export function fmtTime(s: string | null): string | null {
  if (!s) return null
  if (/^\d{1,2}:\d{2}$/.test(s)) { const [h, m] = s.split(':').map(Number); return new Date(Date.UTC(2000, 0, 1, h, m)).toLocaleTimeString('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' }) }
  const d = parseSf(s); if (!d) return null
  return d.toLocaleTimeString('en-US', { timeZone: PT, hour: 'numeric', minute: '2-digit' })
}
function parseSf(s: string): Date | null {
  // SF returns local (PT) wall-clock without a zone; treat it as PT.
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s.trim())
  if (m) {
    const [, y, mo, d, h = '12', mi = '00'] = m
    // Build the instant that shows this wall-clock in PT (DST-safe via offset probe).
    const guess = new Date(`${y}-${mo}-${d}T${h}:${mi}:00Z`)
    const ptStr = guess.toLocaleString('en-US', { timeZone: PT, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    const pm = /(\d{2})\/(\d{2})\/(\d{4}), (\d{2}):(\d{2})/.exec(ptStr)
    if (!pm) return guess
    const shown = Date.UTC(+pm[3], +pm[1] - 1, +pm[2], +pm[4] % 24, +pm[5])
    return new Date(guess.getTime() + (guess.getTime() - shown))
  }
  const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d
}

const statusPlain = (s: string | null): string => (s ?? '').trim() || 'not set'

export function factsFromLive(f: LiveJobFacts, jobLabel: string): Fact[] {
  const out: Fact[] = []
  const day = fmtDay(f.startDate), t1 = fmtTime(f.windowStart ?? f.startDate), t2 = fmtTime(f.windowEnd ?? f.endDate)
  out.push({ id: '', source: 'sf_job', refId: f.jobId, label: `${jobLabel} · status`, text: `The job status in our system is "${statusPlain(f.status)}"${f.subStatus ? ` (${f.subStatus})` : ''}.`, values: [f.status ?? '', f.subStatus ?? ''].filter(Boolean) })
  if (day) {
    out.push({ id: '', source: 'sf_job', refId: f.jobId, label: `${jobLabel} · schedule`, text: `The appointment is scheduled for ${day}${t1 && t2 ? ` with an arrival window of ${t1} to ${t2}` : t1 ? ` at ${t1}` : ''}.`, values: [day, t1 ?? '', t2 ?? '', f.startDate ?? ''].filter(Boolean) })
  } else {
    out.push({ id: '', source: 'sf_job', refId: f.jobId, label: `${jobLabel} · schedule`, text: 'There is no appointment date on the job yet.', values: [] })
  }
  if (f.completedAt) {
    const c = fmtDay(f.completedAt)
    out.push({ id: '', source: 'sf_job', refId: f.jobId, label: `${jobLabel} · completion`, text: `The work was marked complete on ${c}.`, values: [c ?? '', f.completedAt] })
  } else {
    out.push({ id: '', source: 'sf_job', refId: f.jobId, label: `${jobLabel} · completion`, text: 'The job is not marked complete.', values: [] })
  }
  if (f.techs.length) out.push({ id: '', source: 'sf_job', refId: f.jobId, label: `${jobLabel} · technician`, text: `Assigned technician${f.techs.length > 1 ? 's' : ''}: ${f.techs.map(t => t.name).join(', ')}.`, values: f.techs.map(t => t.name) })
  else out.push({ id: '', source: 'sf_job', refId: f.jobId, label: `${jobLabel} · technician`, text: 'No technician is assigned yet.', values: [] })
  if (f.customerName) out.push({ id: '', source: 'sf_job', refId: f.jobId, label: `${jobLabel} · customer`, text: `The customer on the job is ${f.customerName}.`, values: [f.customerName] })
  if (f.poNumber) out.push({ id: '', source: 'sf_job', refId: f.jobId, label: `${jobLabel} · PO`, text: `PO number(s) on the job: ${f.poNumber}.`, values: f.poNumber.split(/[;,/]/).map(s => s.trim()).filter(Boolean) })
  if (f.requiresFollowUp) out.push({ id: '', source: 'sf_job', refId: f.jobId, label: `${jobLabel} · follow-up`, text: 'The job is flagged as requiring follow-up.', values: [] })
  return out
}

export function factsFromVendor(v: VendorContext): Fact[] {
  const out: Fact[] = []
  const label = `${v.vendor === 'clopay_hd' ? 'Clopay' : v.vendor === 'genie_thd' ? 'Genie' : v.vendor} order ${v.externalId}`
  if (v.dcReservedAt) { const d = fmtDay(v.dcReservedAt); out.push({ id: '', source: 'vendor_order', refId: v.externalId, label: `${label} · material`, text: `The distribution center reported the material fully received and reserved on ${d}.`, values: [d ?? ''] }) }
  if (v.status) out.push({ id: '', source: 'vendor_order', refId: v.externalId, label: `${label} · portal status`, text: `The vendor portal shows the order as "${v.status}"${v.nextStep ? ` with next step "${v.nextStep}"` : ''}.`, values: [v.status, v.nextStep ?? ''].filter(Boolean) })
  if (v.storeNumber) out.push({ id: '', source: 'vendor_order', refId: v.externalId, label: `${label} · store`, text: `Home Depot store number ${v.storeNumber}.`, values: [v.storeNumber] })
  return out
}

function factsFromAnswers(rows: AnswerEntry[]): Fact[] {
  return rows.map(a => ({ id: '', source: 'answer_library' as const, refId: a.id, label: `Answer library · ${a.title}`, text: a.answer_text, values: [] }))
}

/** Pick library entries relevant to this question: by type, then by keyword overlap. */
export function pickAnswers(all: AnswerEntry[], questionType: QuestionType, text: string, limit = 3): AnswerEntry[] {
  const words = new Set(text.toLowerCase().split(/\W+/).filter(w => w.length > 3))
  const score = (a: AnswerEntry) => {
    let s = a.question_type === questionType ? 2 : 0
    for (const ex of [a.title, ...a.question_examples]) for (const w of ex.toLowerCase().split(/\W+/)) if (w.length > 3 && words.has(w)) s += 1
    return s
  }
  return all.filter(a => a.is_active && (a.audience === 'partner' || a.audience === 'all')).map(a => [score(a), a] as const).filter(([s]) => s > 0).sort((x, y) => y[0] - x[0]).slice(0, limit).map(([, a]) => a)
}

async function loadVendorContext(db: SupabaseClient, sfJobId: string, pos: string[]): Promise<VendorContext | null> {
  const orFilter = [`sf_job_id.eq.${sfJobId}`, ...pos.map(p => `external_id.eq.${p}`), ...pos.map(p => `customer_po.ilike.%${p}%`)].join(',')
  const { data } = await db.from('vendor_orders').select('vendor, external_id, status, next_step, dc_reserved_at, details_received_at, schedule_date, store_number, record_source').or(orFilter).limit(10)
  const rows = (data ?? []) as Array<{ vendor: string; external_id: string; status: string | null; next_step: string | null; dc_reserved_at: string | null; details_received_at: string | null; schedule_date: string | null; store_number: string | null; record_source: string | null }>
  const r = rows.find(x => x.record_source !== 'ipo_document') ?? rows[0]
  if (!r) return null
  return { vendor: r.vendor, externalId: r.external_id, status: r.status, nextStep: r.next_step, dcReservedAt: r.dc_reserved_at, detailsReceivedAt: r.details_received_at, scheduleDate: r.schedule_date, storeNumber: r.store_number }
}

export interface BuildGroundingInput {
  identifiers: ResolverIdentifiers
  questionType: QuestionType
  questionText: string
  settings: AgentSettings
  /** Test hook: skip Service Fusion and use these facts as the live read. */
  liveOverride?: LiveJobFacts | null
  /** Extra facts supplied by a person (Google Chat answer). Authorise THIS reply only. */
  extraFacts?: Array<Pick<Fact, 'source' | 'refId' | 'label' | 'text' | 'values'>>
}

export async function buildGrounding(db: SupabaseClient, input: BuildGroundingInput): Promise<GroundingPack> {
  const gaps: string[] = []
  const resolve = await resolveJob(db, input.identifiers, { windowDays: input.settings.closed_window_days })
  const allAnswers = await listAnswers(db)
  const answers = pickAnswers(allAnswers, input.questionType, input.questionText)
  let live: LiveRefreshResult | null = null
  let vendor: VendorContext | null = null
  const facts: Fact[] = []

  if (resolve.status === 'matched') {
    const jobLabel = `Job ${resolve.job.number ?? resolve.job.id}`
    live = input.liveOverride
      ? { status: 'fresh', facts: input.liveOverride, fromCache: false, ageMs: 0 }
      : await refreshJob(resolve.job.id, { stalenessMs: input.settings.staleness_minutes * 60_000 })
    if (live.status === 'fresh') facts.push(...factsFromLive(live.facts, jobLabel))
    else gaps.push(`Live Service Fusion read failed (${live.error}); no job facts available.`)
    vendor = await loadVendorContext(db, resolve.job.id, input.identifiers.pos ?? [])
    if (vendor) facts.push(...factsFromVendor(vendor))
    facts.push({ id: '', source: 'resolver', refId: resolve.job.id, label: 'Match', text: `This inquiry was matched to ${jobLabel} by ${resolve.tier === 'po' ? `PO ${resolve.matchedPo}` : resolve.tier}.`, values: [resolve.matchedPo ?? ''].filter(Boolean) })
  } else if (resolve.status === 'ambiguous') {
    gaps.push(`${resolve.candidates.length} jobs matched by ${resolve.tier}: ${resolve.candidates.map(c => c.number ?? c.id).join(', ')}. Cannot pick one.`)
  } else {
    const tried = resolve.tried.length ? resolve.tried.join(', ') : 'nothing usable'
    gaps.push(`No job found (searched by ${tried}).${resolve.outOfScope.length ? ` ${resolve.outOfScope.length} older closed job(s) matched but are outside the ${input.settings.closed_window_days}-day window.` : ''}`)
  }
  facts.push(...factsFromAnswers(answers))
  for (const x of input.extraFacts ?? []) facts.push({ id: '', ...x })
  facts.forEach((f, i) => { f.id = `F${i + 1}` })
  return { resolve, live, facts, answers, vendor, gaps }
}
