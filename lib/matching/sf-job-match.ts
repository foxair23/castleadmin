import type { SupabaseClient } from '@supabase/supabase-js'

// Reusable service: match a 3rd-party order (Genie/Home Depot today, other vendor
// portals later) to a Service Fusion job. Any source normalizes its order into an
// ExternalOrderKey and calls matchToSfJob — the methodology stays in one place.
//
// Match priority (strongest → weakest):
//   1. linked   — an explicit SF job id (Phase 2, once we create the job)
//   2. po        — PO membership: sf_jobs.po_number may list several POs separated
//                  by ; / , so we split BOTH sides and check membership (this is
//                  the key thing a naive equality match gets wrong)
//   3. name      — customer name via a sorted-token key, so "SERRANO, GLORIA"
//                  matches "Gloria Serrano"
//   4. email     — the order's email → its SF customer
//   5. phone     — the order's phone → its SF customer
// name/email/phone resolve ONLY when they point at a single job — otherwise we
// report `ambiguous` and no number, never a guess (same caution as the remittance
// matcher's money path).

export type SfMatchMethod = 'linked' | 'po' | 'name' | 'email' | 'phone'

export interface SfJobMatch {
  sfJobId: string | null
  sfJobNumber: string | null
  method: SfMatchMethod | null
  /** A weaker signal (name/email/phone) matched >1 job, so we didn't pick one. */
  ambiguous: boolean
}

export interface ExternalOrderKey {
  po?: string | null
  customerName?: string | null
  email?: string | null
  phone?: string | null
  linkedJobId?: string | null
}

export interface SfJobLite { id: string; number: string | null; customer_name: string | null; customer_id: string | null; po_number: string | null }
export interface SfCustomerContact { id: string; email: string | null; phone: string | null }

// ── Normalizers (exported for tests / reuse) ────────────────────────────────
export const splitPos = (raw: string | null | undefined): string[] =>
  (raw ?? '').split(/[;/,]/).map(s => s.trim()).filter(Boolean)
export const normName = (s: string | null | undefined): string =>
  (s ?? '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
/** Sorted-token key — order/comma-insensitive ("Last, First" == "First Last"). */
export const nameKey = (s: string | null | undefined): string =>
  normName(s).split(' ').filter(Boolean).sort().join(' ')
export const normEmail = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase()
export const normPhone = (s: string | null | undefined): string => {
  const d = (s ?? '').replace(/\D/g, '')
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d
}

// ── Index ───────────────────────────────────────────────────────────────────
export interface SfJobIndex {
  jobById: Map<string, SfJobLite>
  poToJob: Map<string, SfJobLite>          // first job seen per PO token
  nameToJobs: Map<string, SfJobLite[]>     // deduped by job id
  custToJobs: Map<string, SfJobLite[]>
  emailToCust: Map<string, string>
  phoneToCust: Map<string, string>
}

function pushJob(map: Map<string, SfJobLite[]>, key: string, job: SfJobLite) {
  const arr = map.get(key)
  if (!arr) map.set(key, [job])
  else if (!arr.some(j => j.id === job.id)) arr.push(job)
}

export function buildSfJobIndex(jobs: SfJobLite[], customers: SfCustomerContact[] = []): SfJobIndex {
  const jobById = new Map<string, SfJobLite>()
  const poToJob = new Map<string, SfJobLite>()
  const nameToJobs = new Map<string, SfJobLite[]>()
  const custToJobs = new Map<string, SfJobLite[]>()
  for (const j of jobs) {
    jobById.set(j.id, j)
    for (const p of splitPos(j.po_number)) if (!poToJob.has(p)) poToJob.set(p, j)
    const nk = nameKey(j.customer_name)
    if (nk) pushJob(nameToJobs, nk, j)
    if (j.customer_id) pushJob(custToJobs, j.customer_id, j)
  }
  const emailToCust = new Map<string, string>()
  const phoneToCust = new Map<string, string>()
  for (const c of customers) {
    const e = normEmail(c.email); if (e && !emailToCust.has(e)) emailToCust.set(e, c.id)
    const p = normPhone(c.phone); if (p.length >= 10 && !phoneToCust.has(p)) phoneToCust.set(p, c.id)
  }
  return { jobById, poToJob, nameToJobs, custToJobs, emailToCust, phoneToCust }
}

const hit = (job: SfJobLite, method: SfMatchMethod): SfJobMatch => ({ sfJobId: job.id, sfJobNumber: job.number, method, ambiguous: false })

export function matchToSfJob(index: SfJobIndex, key: ExternalOrderKey): SfJobMatch {
  if (key.linkedJobId) {
    const j = index.jobById.get(key.linkedJobId)
    if (j) return hit(j, 'linked')
  }
  // PO membership — split the order's PO too, in case a source lists several.
  for (const p of splitPos(key.po)) {
    const j = index.poToJob.get(p)
    if (j) return hit(j, 'po')
  }

  let ambiguous = false
  const resolveUnique = (jobs: SfJobLite[] | undefined, method: SfMatchMethod): SfJobMatch | null => {
    if (!jobs || jobs.length === 0) return null
    if (jobs.length === 1) return hit(jobs[0], method)
    ambiguous = true
    return null
  }

  const nk = nameKey(key.customerName)
  const byName = nk ? resolveUnique(index.nameToJobs.get(nk), 'name') : null
  if (byName) return byName

  const emailCust = key.email ? index.emailToCust.get(normEmail(key.email)) : undefined
  const byEmail = emailCust ? resolveUnique(index.custToJobs.get(emailCust), 'email') : null
  if (byEmail) return byEmail

  const phoneCust = key.phone ? index.phoneToCust.get(normPhone(key.phone)) : undefined
  const byPhone = phoneCust ? resolveUnique(index.custToJobs.get(phoneCust), 'phone') : null
  if (byPhone) return byPhone

  return { sfJobId: null, sfJobNumber: null, method: null, ambiguous }
}

// ── DB loader ────────────────────────────────────────────────────────────────
async function fetchAll<T>(run: (from: number, to: number) => Promise<T[]>): Promise<T[]> {
  const PAGE = 1000
  const out: T[] = []
  let from = 0
  for (;;) {
    const page = await run(from, from + PAGE - 1)
    out.push(...page)
    if (page.length < PAGE) break
    from += PAGE
  }
  return out
}

/** Build the index from the SF mirror. `withContacts` pulls customer email/phone
 *  for those fallbacks (skip it if a caller only needs PO/name).
 *
 *  Cached for a short TTL: the index is a pure function of the SF mirror (identical for
 *  every request and user), but building it pages the ENTIRE sf_jobs + sf_customers
 *  tables in ~65 serial PostgREST round-trips — the single slowest step of an HD Orders
 *  page load when done per view. The mirror itself only changes on its sync cadence, so
 *  an index up to 90s old renders identical matches. In-flight promise is shared, so
 *  concurrent renders don't stampede; failures are never cached. */
const INDEX_TTL_MS = 90_000
const indexCache = new Map<string, { at: number; promise: Promise<SfJobIndex> }>()

export function loadSfJobIndex(db: SupabaseClient, opts: { withContacts?: boolean } = {}): Promise<SfJobIndex> {
  const key = opts.withContacts === false ? 'bare' : 'contacts'
  const hit = indexCache.get(key)
  // eslint-disable-next-line react-hooks/purity -- server-side TTL cache, not a component
  const now = Date.now()
  if (hit && now - hit.at < INDEX_TTL_MS) return hit.promise
  const promise = loadSfJobIndexUncached(db, opts)
  indexCache.set(key, { at: now, promise })
  promise.catch(() => { if (indexCache.get(key)?.promise === promise) indexCache.delete(key) })
  return promise
}

async function loadSfJobIndexUncached(db: SupabaseClient, opts: { withContacts?: boolean } = {}): Promise<SfJobIndex> {
  const jobs = await fetchAll<SfJobLite>(async (from, to) => {
    const { data } = await db.from('sf_jobs')
      .select('id, number, customer_name, customer_id, po_number')
      .eq('is_deleted', false).order('id').range(from, to)
    return (data ?? []) as SfJobLite[]
  })
  let customers: SfCustomerContact[] = []
  if (opts.withContacts !== false) {
    customers = await fetchAll<SfCustomerContact>(async (from, to) => {
      const { data } = await db.from('sf_customers')
        .select('id, email:raw_data->>email, phone:raw_data->>phone')
        .eq('is_deleted', false).order('id').range(from, to)
      return (data ?? []) as SfCustomerContact[]
    })
  }
  return buildSfJobIndex(jobs, customers)
}
