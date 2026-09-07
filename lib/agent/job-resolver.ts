import type { SupabaseClient } from '@supabase/supabase-js'
import { splitPos, nameKey, normEmail, normPhone } from '@/lib/matching/sf-job-match'
import { tokenize } from '@/lib/google-reviews/matcher'
import { isCompletedish, CANCELLEDISH } from '@/lib/sf-mirror/completion-status'

// Shared job resolver — the ONE way any Castle agent channel (Cassie email today,
// a phone agent later) turns "who/what is this person asking about" into a Service
// Fusion job. Channels must consume this, never reimplement matching, so two channels
// can never disagree about which job a PO refers to.
//
// Contract:
//   • PO / order number is the primary key. It is checked against BOTH the SF job's
//     po_number field (which may list several POs) AND the vendor-order tables
//     (Home Depot / Clopay orders already linked to an SF job), so a PO that was
//     never typed onto the SF job still resolves.
//   • Customer name, email and phone are weaker keys and resolve ONLY when they
//     point at exactly one in-scope job.
//   • Anything pointing at more than one job is `ambiguous` with the candidates
//     listed — the resolver never picks a best guess.
//   • Scope is the active pipeline plus a trailing window of closed jobs (default
//     60 days). Cancelled/void jobs are never in scope.
//
// The logic is pure (resolveFromCandidates) so it is unit-testable; the DB loader
// (resolveJob) only gathers candidates. Nothing here talks to Service Fusion —
// this reads the mirror only; live refresh is a separate service.

export type ResolveTier = 'po' | 'name' | 'email' | 'phone'

export interface ResolverIdentifiers {
  /** PO / order numbers as written by the sender (any separators; several allowed). */
  pos?: string[]
  customerName?: string | null
  email?: string | null
  phone?: string | null
}

/** The mirror fields the resolver needs to decide scope + identity. */
export interface CandidateJob {
  id: string
  number: string | null
  customer_id: string | null
  customer_name: string | null
  contact_first_name?: string | null
  contact_last_name?: string | null
  po_number: string | null
  status: string | null
  start_date: string | null
  end_date?: string | null
  closed_at: string | null
  work_completed_at?: string | null
  is_deleted?: boolean
}

/** A vendor-portal order (Home Depot / Clopay / Genie) already tied to an SF job. */
export interface VendorLink {
  vendor: string
  /** Every PO-like identifier on the order (external_id, customer_po, group POs). */
  pos: string[]
  sf_job_id: string | null
}

/** customer id → contact emails/phones from the mirror. */
export interface CustomerContacts {
  emailToCustomer: Map<string, string>
  phoneToCustomer: Map<string, string>
}

export interface ResolvedMatch {
  status: 'matched'
  tier: ResolveTier
  job: CandidateJob
  /** Which PO actually matched, when tier === 'po'. */
  matchedPo?: string
  /** True when the PO came from a vendor order rather than the SF job's own PO field. */
  viaVendorOrder?: boolean
}
export interface AmbiguousMatch {
  status: 'ambiguous'
  tier: ResolveTier
  candidates: CandidateJob[]
}
export interface NoMatch {
  status: 'none'
  /** Which identifiers were tried, so the composer can say what it looked for. */
  tried: ResolveTier[]
  /** Identifiers that hit a job OUTSIDE the scope window (closed long ago). */
  outOfScope: CandidateJob[]
}
export type ResolveResult = ResolvedMatch | AmbiguousMatch | NoMatch

export const DEFAULT_CLOSED_WINDOW_DAYS = 60

// ── Scope ─────────────────────────────────────────────────────────────────────

const dayMs = 86_400_000
const toMs = (s: string | null | undefined): number | null => {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}

/** Active pipeline, or closed within `windowDays`. Cancelled/void/deleted never. */
export function isInScope(job: CandidateJob, now: number, windowDays = DEFAULT_CLOSED_WINDOW_DAYS): boolean {
  if (job.is_deleted) return false
  const status = (job.status ?? '').trim()
  if (CANCELLEDISH.test(status)) return false
  if (!isCompletedish(status)) return true
  // Closed: the most reliable "when did it finish" we have, in order of trust.
  const finished = toMs(job.work_completed_at) ?? toMs(job.closed_at) ?? toMs(job.end_date) ?? toMs(job.start_date)
  if (finished == null) return false
  return now - finished <= windowDays * dayMs
}

// ── Normalisers ───────────────────────────────────────────────────────────────

/** A PO as a comparable token: digits/letters only, upper-case. "PO# 1020259181" → "1020259181". */
export const normPo = (raw: string): string => raw.toUpperCase().replace(/^PO\s*#?\s*/i, '').replace(/[^A-Z0-9]/g, '')

/** Every PO token on a job's po_number field (may list several). */
export const jobPoTokens = (po: string | null | undefined): string[] => splitPos(po).map(normPo).filter(Boolean)

const uniqById = (jobs: CandidateJob[]): CandidateJob[] => {
  const seen = new Set<string>()
  return jobs.filter(j => (seen.has(j.id) ? false : (seen.add(j.id), true)))
}

/** Sorted canonical name tokens (nicknames folded) — "Kathy Messerschmidt" ≈ "MESSERSCHMIDT, CATHERINE". */
const looseNameKey = (s: string | null | undefined): string => tokenize(s ?? '').sort().join(' ')

// ── Pure resolution ───────────────────────────────────────────────────────────

export interface ResolveInput {
  identifiers: ResolverIdentifiers
  jobs: CandidateJob[]
  vendorLinks?: VendorLink[]
  contacts?: CustomerContacts
  now?: number
  windowDays?: number
}

export function resolveFromCandidates(input: ResolveInput): ResolveResult {
  const now = input.now ?? Date.now()
  const windowDays = input.windowDays ?? DEFAULT_CLOSED_WINDOW_DAYS
  const jobById = new Map(input.jobs.map(j => [j.id, j]))
  const inScope = (j: CandidateJob) => isInScope(j, now, windowDays)
  const tried: ResolveTier[] = []
  const outOfScope: CandidateJob[] = []

  // 1. PO — SF job's own PO field, then vendor orders linked to a job.
  const pos = (input.identifiers.pos ?? []).flatMap(p => splitPos(p)).map(normPo).filter(Boolean)
  if (pos.length) {
    tried.push('po')
    for (const po of pos) {
      const direct = input.jobs.filter(j => jobPoTokens(j.po_number).includes(po))
      const viaVendor = (input.vendorLinks ?? [])
        .filter(v => v.sf_job_id && v.pos.map(normPo).includes(po))
        .map(v => jobById.get(v.sf_job_id!))
        .filter((j): j is CandidateJob => !!j)
      const all = uniqById([...direct, ...viaVendor])
      const live = all.filter(inScope)
      if (live.length === 1) {
        return { status: 'matched', tier: 'po', job: live[0], matchedPo: po, viaVendorOrder: direct.length === 0 }
      }
      if (live.length > 1) return { status: 'ambiguous', tier: 'po', candidates: live }
      outOfScope.push(...all)
    }
  }

  // 2. Customer name — exact sorted-token key first, then nickname-folded key.
  const rawName = input.identifiers.customerName
  if (rawName && rawName.trim()) {
    tried.push('name')
    const exactKey = nameKey(rawName)
    const looseKey = looseNameKey(rawName)
    const jobName = (j: CandidateJob) => j.customer_name || [j.contact_first_name, j.contact_last_name].filter(Boolean).join(' ')
    const exact = input.jobs.filter(j => nameKey(jobName(j)) === exactKey)
    const loose = exact.length ? exact : (looseKey ? input.jobs.filter(j => looseNameKey(jobName(j)) === looseKey) : [])
    const live = uniqById(loose).filter(inScope)
    if (live.length === 1) return { status: 'matched', tier: 'name', job: live[0] }
    if (live.length > 1) return { status: 'ambiguous', tier: 'name', candidates: live }
    outOfScope.push(...loose)
  }

  // 3/4. Email, phone → customer → that customer's in-scope jobs.
  const byCustomer = (custId: string) => input.jobs.filter(j => j.customer_id === custId)
  const contactTier = (tier: 'email' | 'phone', custId: string | undefined): ResolveResult | null => {
    if (!custId) return null
    const jobs = byCustomer(custId)
    const live = uniqById(jobs).filter(inScope)
    if (live.length === 1) return { status: 'matched', tier, job: live[0] }
    if (live.length > 1) return { status: 'ambiguous', tier, candidates: live }
    outOfScope.push(...jobs)
    return null
  }
  if (input.identifiers.email && input.contacts) {
    tried.push('email')
    const r = contactTier('email', input.contacts.emailToCustomer.get(normEmail(input.identifiers.email)))
    if (r) return r
  }
  if (input.identifiers.phone && input.contacts) {
    const p = normPhone(input.identifiers.phone)
    if (p.length >= 10) {
      tried.push('phone')
      const r = contactTier('phone', input.contacts.phoneToCustomer.get(p))
      if (r) return r
    }
  }

  return { status: 'none', tried, outOfScope: uniqById(outOfScope) }
}

// ── DB loader ─────────────────────────────────────────────────────────────────
// Candidate gathering is deliberately narrow: only rows that could match one of the
// supplied identifiers are fetched, so a resolve is a handful of indexed queries
// rather than a full-table index build (that index exists for bulk screens; an
// email reply needs one job, now).

const JOB_COLS = 'id, number, customer_id, customer_name, contact_first_name, contact_last_name, po_number, status, start_date, end_date, closed_at, work_completed_at, is_deleted'

export async function resolveJob(db: SupabaseClient, identifiers: ResolverIdentifiers, opts: { windowDays?: number; now?: number } = {}): Promise<ResolveResult> {
  const jobs: CandidateJob[] = []
  const vendorLinks: VendorLink[] = []
  const contacts: CustomerContacts = { emailToCustomer: new Map(), phoneToCustomer: new Map() }
  const jobIds = new Set<string>()
  const addJobs = (rows: CandidateJob[] | null | undefined) => {
    for (const r of rows ?? []) if (!jobIds.has(r.id)) { jobIds.add(r.id); jobs.push(r) }
  }

  const pos = (identifiers.pos ?? []).flatMap(p => splitPos(p)).map(normPo).filter(Boolean)
  if (pos.length) {
    // SF's own PO field: substring pre-filter, exact membership decided in memory.
    const poFilter = pos.map(p => `po_number.ilike.%${p}%`).join(',')
    const { data } = await db.from('sf_jobs').select(JOB_COLS).eq('is_deleted', false).or(poFilter).limit(50)
    addJobs(data as CandidateJob[] | null)

    // Vendor orders (HD / Clopay / Genie) carrying this PO and already linked to a job.
    // Clopay's PO is the order's external_id; Genie/HD carry it in customer_po.
    const voFilter = pos.flatMap(p => [`external_id.eq.${p}`, `customer_po.ilike.%${p}%`]).join(',')
    const { data: vo } = await db.from('vendor_orders')
      .select('vendor, external_id, customer_po, sf_job_id')
      .not('sf_job_id', 'is', null).or(voFilter).limit(50)
    for (const v of (vo ?? []) as Array<{ vendor: string; external_id: string; customer_po: string | null; sf_job_id: string | null }>) {
      vendorLinks.push({ vendor: v.vendor, sf_job_id: v.sf_job_id, pos: [v.external_id, ...splitPos(v.customer_po)].filter(Boolean) })
    }
    const linked = vendorLinks.map(v => v.sf_job_id!).filter(id => !jobIds.has(id))
    if (linked.length) {
      const { data: lj } = await db.from('sf_jobs').select(JOB_COLS).in('id', linked)
      addJobs(lj as CandidateJob[] | null)
    }
  }

  if (identifiers.customerName?.trim()) {
    // Pre-filter on the longest name token (surname, usually); exact/loose keys decide in memory.
    const tokens = tokenize(identifiers.customerName)
    const anchor = tokens.sort((a, b) => b.length - a.length)[0]
    if (anchor && anchor.length >= 2) {
      const { data } = await db.from('sf_jobs').select(JOB_COLS).eq('is_deleted', false)
        .or(`customer_name.ilike.%${anchor}%,contact_last_name.ilike.%${anchor}%,contact_first_name.ilike.%${anchor}%`)
        .limit(200)
      addJobs(data as CandidateJob[] | null)
    }
  }

  const custIds = new Set<string>()
  if (identifiers.email) {
    const e = normEmail(identifiers.email)
    if (e) {
      const { data } = await db.from('sf_contact_emails').select('email, sf_customer_contacts!inner(customer_id)').ilike('email', e).limit(20)
      for (const r of (data ?? []) as unknown as Array<{ email: string; sf_customer_contacts: { customer_id: string } | { customer_id: string }[] }>) {
        const c = Array.isArray(r.sf_customer_contacts) ? r.sf_customer_contacts[0] : r.sf_customer_contacts
        if (c?.customer_id) { contacts.emailToCustomer.set(e, c.customer_id); custIds.add(c.customer_id) }
      }
    }
  }
  if (identifiers.phone) {
    const p = normPhone(identifiers.phone)
    if (p.length >= 10) {
      const { data } = await db.from('sf_contact_phones').select('phone, sf_customer_contacts!inner(customer_id)').ilike('phone', `%${p.slice(-7)}%`).limit(50)
      for (const r of (data ?? []) as unknown as Array<{ phone: string | null; sf_customer_contacts: { customer_id: string } | { customer_id: string }[] }>) {
        if (normPhone(r.phone) !== p) continue
        const c = Array.isArray(r.sf_customer_contacts) ? r.sf_customer_contacts[0] : r.sf_customer_contacts
        if (c?.customer_id) { contacts.phoneToCustomer.set(p, c.customer_id); custIds.add(c.customer_id) }
      }
    }
  }
  if (custIds.size) {
    const { data } = await db.from('sf_jobs').select(JOB_COLS).eq('is_deleted', false).in('customer_id', [...custIds]).limit(200)
    addJobs(data as CandidateJob[] | null)
  }

  return resolveFromCandidates({ identifiers, jobs, vendorLinks, contacts, now: opts.now, windowDays: opts.windowDays })
}
