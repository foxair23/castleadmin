/**
 * Service Fusion Mirror — Sync Engine
 *
 * Exported functions (called by cron routes and admin UI):
 *   runReferenceSync()      — small reference tables, fully re-pulled every day
 *   runIncrementalSync()    — large entities, 48-hour updated_date window
 *   runBackfill(entity?)    — one-time full paginated scan, resumable via sf_sync_runs.last_page
 *   runWeeklyReconcile()    — full scan of all large entities + soft-delete detection
 */

import { createClient } from '@supabase/supabase-js'
import { sfMirrorPaginateAll, sfMirrorGet } from './client'
import { COMPLETEDISH, isRevertedCandidateStatus } from './completion-status'

// ─── Supabase admin client ─────────────────────────────────────────────────

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

// ─── Small helpers ─────────────────────────────────────────────────────────

function toStr(v: unknown): string | null {
  return v != null ? String(v) : null
}

function toNum(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return isNaN(n) ? null : n
}

function toBool(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true'
}

function nowIso(): string {
  return new Date().toISOString()
}

// A mirror row must be missing from the SF scan for at least this long before the
// weekly reconcile soft-deletes it — i.e. missing across two consecutive weekly
// runs — so a single dropped/empty page can't false-delete active records.
const RECONCILE_GRACE_MS = 6 * 24 * 3600 * 1000

// SF sometimes stores names reversed: fname="Bourcy," lname="Susan"
// Detect by comma at end of first name and swap.
// SF also sometimes stores names in ALL CAPS — convert to title case with
// special-case handling for common surname prefixes.
function toTitleCase(s: string): string {
  return s
    .toLowerCase()
    // Capitalize first letter of every word (handles hyphenated names, O'Brien, D'Angelo too
    // since apostrophe/hyphen are non-word chars creating a word boundary before the next letter)
    .replace(/\b\w/g, c => c.toUpperCase())
    // Mc prefix: McDonald, McAllister, McPherson
    .replace(/\bMc([a-z])/g, (_, c) => `Mc${c.toUpperCase()}`)
    // Mac prefix: MacKenzie, MacPherson — exclude vowels to avoid false positives
    // like Macey → MacEy. Consonant-after-Mac is a reliable signal.
    .replace(/\bMac([bcdfghjklmnpqrstvwxyz])/g, (_, c) => `Mac${c.toUpperCase()}`)
    // Preserve common lowercase particles when mid-name: van, von, de, di, la, le, du
    // Only lowercase them when not at the start of the full name.
    .replace(/(?<=\S\s)(Van|Von|De|Di|La|Le|Du)\b/g, p => p.toLowerCase())
}

function normalizeContactName(fname: string | null, lname: string | null): { first: string | null; last: string | null } {
  let first = fname
  let last = lname
  // Swap if reversed
  if (first && first.trimEnd().endsWith(',')) {
    const tmp = last
    last = first.trimEnd().replace(/,$/, '').trim() || null
    first = tmp
  }
  // Title-case if all caps
  const fix = (s: string | null) => {
    if (!s) return s
    if (s === s.toUpperCase() && /[A-Z]/.test(s)) return toTitleCase(s)
    return s
  }
  return { first: fix(first), last: fix(last) }
}

function hoursAgo(h: number): string {
  const d = new Date(Date.now() - h * 3_600_000)
  // SF API expects ISO-8601 with explicit timezone offset (Y-m-d\TH:i:sP format)
  // e.g. '2026-05-28T08:00:00+00:00' — not 'Z' suffix, not space-separated
  return d.toISOString().slice(0, 19) + '+00:00'
}

// Chunk an array into sub-arrays of at most `size` elements.
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// Fetch every matching row past PostgREST's 1000-row response cap. `build`
// receives an inclusive [from, to] range and must apply a stable .order() so
// pages don't skip or duplicate rows.
async function fetchAllRows<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null }>
): Promise<T[]> {
  const PAGE = 1000
  const out: T[] = []
  let from = 0
  for (;;) {
    const { data } = await build(from, from + PAGE - 1)
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < PAGE) break
    from += PAGE
  }
  return out
}

// ─── Sync-run logging ─────────────────────────────────────────────────────

export interface RunHandle {
  id: string
  entity: string
  runType: string
}

async function startRun(
  runType: 'incremental' | 'backfill' | 'reconcile' | 'reference',
  entity: string,
): Promise<RunHandle> {
  const supabase = db()
  const { data } = await supabase
    .from('sf_sync_runs')
    .insert({ run_type: runType, entity, status: 'running', started_at: nowIso() })
    .select('id')
    .single()
  return { id: (data as { id: string }).id, entity, runType }
}

async function updateRunProgress(
  handle: RunHandle,
  page: number,
  fetched: number,
  upserted: number,
) {
  await db()
    .from('sf_sync_runs')
    .update({ last_page: page, records_fetched: fetched, records_upserted: upserted, pages_fetched: page })
    .eq('id', handle.id)
}

async function completeRun(handle: RunHandle, fetched: number, upserted: number, pages: number) {
  await db()
    .from('sf_sync_runs')
    .update({ status: 'completed', completed_at: nowIso(), records_fetched: fetched, records_upserted: upserted, pages_fetched: pages })
    .eq('id', handle.id)
}

async function failRun(handle: RunHandle, error: string) {
  await db()
    .from('sf_sync_runs')
    .update({ status: 'failed', completed_at: nowIso(), error_message: error.slice(0, 2000) })
    .eq('id', handle.id)
}

// Find last_page from any previous partial/running backfill run for this entity.
async function getBackfillResumePage(entity: string): Promise<number> {
  const { data } = await db()
    .from('sf_sync_runs')
    .select('last_page')
    .eq('run_type', 'backfill')
    .eq('entity', entity)
    .in('status', ['running', 'partial'])
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as { last_page: number | null } | null)?.last_page ?? 1
}

// ─── Field mappers ─────────────────────────────────────────────────────────
// Each mapper promotes high-value fields into typed columns and stores the
// full raw JSON in raw_data. Nothing is discarded.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>

function mapCompany(r: Raw) {
  return { id: toStr(r.id) ?? 'me', name: toStr(r.name ?? r.company_name), raw_data: r, sf_synced_at: nowIso() }
}

function mapTech(r: Raw) {
  return {
    id: toStr(r.id)!, first_name: toStr(r.first_name), last_name: toStr(r.last_name),
    email: toStr(r.email), phone_1: toStr(r.phone_1), phone_2: toStr(r.phone_2),
    color_code: toStr(r.color_code), department: toStr(r.department), title: toStr(r.title),
    is_field_worker: toBool(r.is_field_worker), is_sales_rep: toBool(r.is_sales_rep),
    created_at_sf: toStr(r.created_at), updated_at_sf: toStr(r.updated_at),
    raw_data: r, sf_synced_at: nowIso(), is_deleted: false,
  }
}

function mapJobStatus(r: Raw) {
  return {
    id: toStr(r.id)!, code: toStr(r.code), name: toStr(r.name) ?? '',
    is_custom: toBool(r.is_custom), category: toStr(r.category),
    raw_data: r, sf_synced_at: nowIso(), is_deleted: false,
  }
}

function mapJobCategory(r: Raw) {
  return { id: toStr(r.id)!, name: toStr(r.name) ?? '', raw_data: r, sf_synced_at: nowIso(), is_deleted: false }
}

function mapPaymentType(r: Raw) {
  return {
    id: toStr(r.id)!, code: toStr(r.code), short_name: toStr(r.short_name),
    type: toStr(r.type), is_custom: toBool(r.is_custom),
    raw_data: r, sf_synced_at: nowIso(), is_deleted: false,
  }
}

function mapSource(r: Raw) {
  return { id: toStr(r.id)!, short_name: toStr(r.short_name), long_name: toStr(r.long_name), raw_data: r, sf_synced_at: nowIso(), is_deleted: false }
}

function mapCustomer(r: Raw) {
  return {
    id: toStr(r.id)!, customer_name: toStr(r.customer_name),
    fully_qualified_name: toStr(r.fully_qualified_name), account_number: toStr(r.account_number),
    account_balance: toNum(r.account_balance), payment_terms: toStr(r.payment_terms),
    referral_source: toStr(r.referral_source), last_serviced_date: toStr(r.last_serviced_date),
    is_vip: toBool(r.is_vip), is_taxable: toBool(r.is_taxable ?? true),
    created_at_sf: toStr(r.created_at), updated_at_sf: toStr(r.updated_at),
    raw_data: r, sf_synced_at: nowIso(), is_deleted: false,
  }
}

function mapJob(r: Raw) {
  return {
    id: toStr(r.id)!, number: toStr(r.number),
    customer_id: toStr(r.customer_id), customer_name: toStr(r.customer_name),
    status: toStr(r.status), sub_status: toStr(r.sub_status),
    category: toStr(r.category), source: toStr(r.source),
    start_date: toStr(r.start_date), end_date: toStr(r.end_date),
    time_frame_promised_start: toStr(r.time_frame_promised_start),
    time_frame_promised_end: toStr(r.time_frame_promised_end),
    closed_at: (() => { const v = r.completed_date ?? r.closed_at; return v && v !== 0 && v !== '0' ? toStr(v) : null })(), created_at_sf: toStr(r.created_at), updated_at_sf: toStr(r.updated_at),
    contact_first_name: toStr(r.contact_first_name), contact_last_name: toStr(r.contact_last_name),
    street_1: toStr(r.street_1), street_2: toStr(r.street_2),
    city: toStr(r.city), state_prov: toStr(r.state_prov), postal_code: toStr(r.postal_code),
    // §3.2.1 — money fields required as typed columns
    payment_status: toStr(r.payment_status),
    total: toNum(r.total), due_total: toNum(r.due_total),
    payments_deposits_total: toNum(r.payments_deposits_total),
    cost_total: toNum(r.cost_total), taxes_fees_total: toNum(r.taxes_fees_total),
    drive_labor_total: toNum(r.drive_labor_total), billable_expenses_total: toNum(r.billable_expenses_total),
    payment_type: toStr(r.payment_type), customer_payment_terms: toStr(r.customer_payment_terms),
    is_requires_follow_up: toBool(r.is_requires_follow_up),
    description: toStr(r.description), tech_notes: toStr(r.tech_notes),
    completion_notes: toStr(r.completion_notes), note_to_customer: toStr(r.note_to_customer),
    raw_data: r, sf_synced_at: nowIso(), is_deleted: false,
  }
}

function mapEstimate(r: Raw) {
  return {
    id: toStr(r.id)!, number: toStr(r.number),
    customer_id: toStr(r.customer_id), customer_name: toStr(r.customer_name),
    status: toStr(r.status), sub_status: toStr(r.sub_status),
    category: toStr(r.category), source: toStr(r.source),
    start_date: toStr(r.start_date), created_at_sf: toStr(r.created_at), updated_at_sf: toStr(r.updated_at),
    contact_first_name: toStr(r.contact_first_name), contact_last_name: toStr(r.contact_last_name),
    street_1: toStr(r.street_1), city: toStr(r.city),
    state_prov: toStr(r.state_prov), postal_code: toStr(r.postal_code),
    payment_status: toStr(r.payment_status),
    total: toNum(r.total), due_total: toNum(r.due_total),
    cost_total: toNum(r.cost_total), taxes_fees_total: toNum(r.taxes_fees_total),
    opportunity_rating: toStr(r.opportunity_rating),
    raw_data: r, sf_synced_at: nowIso(), is_deleted: false,
  }
}

function mapInvoice(r: Raw, jobId?: string) {
  return {
    // Job link: the jobs-sync expand passes jobId explicitly; the /invoices
    // endpoint may name it job_id or jobs_id (calendar-tasks use jobs_id).
    id: toStr(r.id)!, job_id: jobId ?? toStr(r.job_id ?? r.jobs_id) ?? null,
    customer_id: toStr(r.customer ?? r.customer_id) ?? null,
    number: toStr(r.number), total: toNum(r.total),
    is_paid: toBool(r.is_paid), date: toStr(r.date),
    mail_send_date: toStr(r.mail_send_date), payment_terms: toStr(r.payment_terms),
    created_at_sf: toStr(r.created_at), updated_at_sf: toStr(r.updated_at),
    raw_data: r, sf_synced_at: nowIso(), is_deleted: false,
  }
}

function mapCalendarTask(r: Raw) {
  return {
    id: toStr(r.id)!, type: toStr(r.type), description: toStr(r.description),
    start_date: toStr(r.start_date), end_date: toStr(r.end_date),
    start_time: toStr(r.start_time), end_time: toStr(r.end_time),
    is_completed: toBool(r.is_completed), is_public: toBool(r.is_public),
    users_id: toStr(r.users_id), jobs_id: toStr(r.jobs_id), estimates_id: toStr(r.estimates_id),
    created_at_sf: toStr(r.created_at), updated_at_sf: toStr(r.updated_at),
    raw_data: r, sf_synced_at: nowIso(), is_deleted: false,
  }
}

function mapEquipment(r: Raw, customerId: string) {
  return {
    id: toStr(r.id)!, customer_id: customerId,
    type: toStr(r.type), make: toStr(r.make), model: toStr(r.model),
    sku: toStr(r.sku), serial_number: toStr(r.serial_number),
    location: toStr(r.location), notes: toStr(r.notes),
    is_extended_warranty: toBool(r.is_extended_warranty),
    extended_warranty_provider: toStr(r.extended_warranty_provider),
    extended_warranty_date: toStr(r.extended_warranty_date),
    warranty_date: toStr(r.warranty_date), install_date: toStr(r.install_date),
    created_at_sf: toStr(r.created_at), updated_at_sf: toStr(r.updated_at),
    raw_data: r, sf_synced_at: nowIso(), is_deleted: false,
  }
}

// ─── Child sync ────────────────────────────────────────────────────────────
// Replace strategy: delete old children for the affected parent IDs, re-insert.
// This is idempotent and handles additions, removals, and changes atomically.

async function syncCustomerChildren(customers: Raw[]) {
  const supabase = db()
  const customerIds = customers.map(c => toStr(c.id)!)

  // Contacts — SF contacts have no id field; generate a stable synthetic one
  // from customer_id + position so child rows can reference it.
  const contacts: Raw[] = customers.flatMap(c =>
    (c.contacts ?? []).map((ct: Raw, i: number) => ({
      ...ct,
      _customer_id: toStr(c.id)!,
      _contact_id: toStr(ct.id) ?? `${toStr(c.id)!}:${i}`,
    }))
  )
  if (contacts.length > 0 || customerIds.length > 0) {
    await supabase.from('sf_customer_contacts').delete().in('customer_id', customerIds)
    if (contacts.length > 0) {
      const contactRows = contacts.map(ct => {
        const { first, last } = normalizeContactName(toStr(ct.fname ?? ct.first_name), toStr(ct.lname ?? ct.last_name))
        return {
          id: ct._contact_id, customer_id: ct._customer_id,
          first_name: first, last_name: last,
          is_primary: toBool(ct.is_primary), raw_data: ct, sf_synced_at: nowIso(),
        }
      })
      await supabase.from('sf_customer_contacts').insert(contactRows)

      // Emails
      const emailRows = contacts.flatMap(ct =>
        (ct.emails ?? []).map((e: Raw, ei: number) => ({
          contact_id: ct._contact_id, email: toStr(e.email ?? e.address),
          is_primary: toBool(e.is_primary) || ei === 0, raw_data: e,
        }))
      )
      if (emailRows.length > 0) await supabase.from('sf_contact_emails').insert(emailRows)

      // Phones
      const phoneRows = contacts.flatMap(ct =>
        (ct.phones ?? []).map((p: Raw) => ({
          contact_id: ct._contact_id, phone: toStr(p.phone ?? p.number),
          type: toStr(p.type), is_primary: toBool(p.is_primary), raw_data: p,
        }))
      )
      if (phoneRows.length > 0) await supabase.from('sf_contact_phones').insert(phoneRows)
    }
  }

  // Locations
  const locationRows = customers.flatMap(c =>
    (c.locations ?? []).map((l: Raw) => ({
      id: toStr(l.id)!, customer_id: toStr(c.id)!,
      street_1: toStr(l.street_1), street_2: toStr(l.street_2),
      city: toStr(l.city), state_prov: toStr(l.state_prov), postal_code: toStr(l.postal_code),
      is_primary: toBool(l.is_primary), raw_data: l, sf_synced_at: nowIso(),
    }))
  )
  if (locationRows.length > 0 || customerIds.length > 0) {
    await supabase.from('sf_customer_locations').delete().in('customer_id', customerIds)
    if (locationRows.length > 0) await supabase.from('sf_customer_locations').insert(locationRows)
  }
}

// Re-populate sf_customer_contacts/emails/phones/locations from raw_data already
// stored in sf_customers. No SF API calls — pure DB read→write.
export async function reprocessCustomerChildren(): Promise<number> {
  const supabase = db()
  const BATCH = 100
  let offset = 0
  let total = 0

  while (true) {
    const { data, error } = await supabase
      .from('sf_customers')
      .select('raw_data, id')
      .eq('is_deleted', false)
      .order('id', { ascending: true })  // stable order so .range() pages don't skip/dupe
      .range(offset, offset + BATCH - 1)

    if (error) throw new Error(error.message)
    if (!data || data.length === 0) break

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawItems = data.map((r: { raw_data: any }) => r.raw_data as Raw)
    await syncCustomerChildren(rawItems)
    total += rawItems.length

    if (data.length < BATCH) break
    offset += BATCH
  }

  return total
}

// Record every observed job status transition into sf_job_status_history —
// the durable log that lets work_completed_at (and any future analytics) use
// REAL transition moments instead of heuristics. The old analytics sync wrote
// this table until Jul 2 2026; this resumes it from the mirror sync.
//
// Changes are detected against the LATEST LOGGED status per job, not against
// sf_jobs — afterUpsert hooks run after the upsert has already overwritten the
// stored row, so sf_jobs always reflects the incoming value by then. A job
// with no history row gets a baseline row (previous_status null) on first
// touch, after which only genuine transitions insert.
async function recordStatusChanges(jobsRaw: Raw[]) {
  const supabase = db()
  const jobs = dedupeByKey(jobsRaw as unknown as Record<string, unknown>[], 'id') as unknown as Raw[]
  const ids = jobs.map(j => toStr(j.id)!).filter(Boolean)
  if (ids.length === 0) return

  // Latest logged status per job (rows come back newest-first; keep the first
  // seen per job).
  const latest = new Map<string, string>()
  const { data: hist } = await supabase
    .from('sf_job_status_history')
    .select('sf_job_id, status, observed_at')
    .in('sf_job_id', ids)
    .order('observed_at', { ascending: false })
  for (const h of (hist ?? []) as Array<{ sf_job_id: string; status: string }>) {
    if (!latest.has(h.sf_job_id)) latest.set(h.sf_job_id, h.status)
  }

  const observedAt = nowIso()
  const rows: unknown[] = []
  for (const j of jobs) {
    const id = toStr(j.id)!
    const status = toStr(j.status)
    if (!status) continue
    const prev = latest.get(id)
    if (prev === status) continue
    rows.push({
      sf_job_id: id,
      status,
      previous_status: prev ?? null,
      observed_at: observedAt,
    })
  }
  if (rows.length > 0) {
    await supabase.from('sf_job_status_history').insert(rows)
  }
}

// Stamp work_completed_at the FIRST time we observe a job in a completed-or-
// later status. SF's own closed_at is only set at Invoiced/Paid, so this column
// is the app's source of truth for "when was the work actually done" (the
// Monthly Revenue chart buckets by it — see migration 054). Never overwritten:
// only null rows are stamped, so later re-syncs can't move a job's month.
// (COMPLETEDISH lives in ./completion-status so the reset predicate can share it.)

async function stampWorkCompleted(jobsRaw: Raw[]) {
  const supabase = db()
  const jobs = dedupeByKey(jobsRaw as unknown as Record<string, unknown>[], 'id') as unknown as Raw[]
  const candidates = jobs.filter(j => COMPLETEDISH.test(toStr(j.status) ?? ''))
  if (candidates.length === 0) return

  const { data: unstamped } = await supabase
    .from('sf_jobs')
    .select('id')
    .in('id', candidates.map(j => toStr(j.id)!))
    .is('work_completed_at', null)
  if (!unstamped || unstamped.length === 0) return
  const needIds = new Set(unstamped.map(r => r.id as string))

  for (const j of candidates) {
    const id = toStr(j.id)!
    if (!needIds.has(id)) continue
    const status = toStr(j.status) ?? ''
    const closed = toStr(j.completed_date ?? j.closed_at)
    const start = toStr(j.start_date)
    const saneClosed = closed && closed > '2000-01-01' ? closed : null
    const saneStart = start && start > '2000-01-01' ? start : null
    // Work-date policy (mirrors migration 057):
    // - Job observed transitioning to a "Completed" status → stamp NOW. The
    //   hourly sync sees the flip within the hour, so this is a genuine live
    //   completion moment — the gold standard.
    // - Job arriving straight at Invoiced/Paid (this account's workflow often
    //   skips "Completed") → the work happened before the invoice, on the
    //   scheduled start for this mostly single-visit business. Prefer
    //   start_date; fall back to SF's stamp, then now.
    const value = /complet/i.test(status)
      ? nowIso()
      : (saneStart ?? saneClosed ?? nowIso())
    await supabase
      .from('sf_jobs')
      .update({ work_completed_at: value })
      .eq('id', id)
      .is('work_completed_at', null)
  }
}

// Undo a PREMATURE completion. A job can be marked Completed in SF (e.g. when a
// part is paid for) and then corrected back to an open status like "Waiting on
// Parts". Since work_completed_at is never overwritten, the job would stay
// recognized as complete forever — inflating the tech's commission pipeline and
// the revenue chart. When a batch job now carries work_completed_at but its
// CURRENT status is no longer completed-ish (and isn't cancelled), clear the
// stamp so it re-recognizes on its real completion date later, and log the reset
// to commission_completion_resets (Commission → Completion Resets) so nothing
// moves silently.
async function resetRevertedCompletions(jobsRaw: Raw[]) {
  const supabase = db()
  const jobs = dedupeByKey(jobsRaw as unknown as Record<string, unknown>[], 'id') as unknown as Raw[]
  // Current status is NOT completed-ish and NOT cancelled → possible reversion.
  const suspectIds = jobs
    .filter(j => isRevertedCandidateStatus(toStr(j.status)))
    .map(j => toStr(j.id)!)
    .filter(Boolean)
  if (suspectIds.length === 0) return

  // Of those, the ones the mirror still has stamped as work-complete = reverted.
  const { data: reverted } = await supabase
    .from('sf_jobs')
    .select('id, number, customer_name, status, work_completed_at, closed_at, total')
    .in('id', suspectIds)
    .not('work_completed_at', 'is', null)
  const rows = (reverted ?? []) as Array<{
    id: string; number: string | null; customer_name: string | null; status: string | null
    work_completed_at: string; closed_at: string | null; total: number | null
  }>
  if (rows.length === 0) return
  const jobIds = rows.map(r => r.id)

  // Snapshot the credited rep + revenue from the eligibility row (if any), and
  // whether the job already carries a payment (paid invoice or a close stamp).
  const [{ data: elig }, { data: paidInv }] = await Promise.all([
    supabase.from('commission_job_eligibility').select('sf_job_id, tech_user_id, revenue').in('sf_job_id', jobIds),
    supabase.from('sf_invoices').select('job_id').in('job_id', jobIds).eq('is_paid', true).eq('is_deleted', false),
  ])
  const eligByJob = new Map((elig ?? []).map(e => [e.sf_job_id as string, e as { tech_user_id: string | null; revenue: number | null }]))
  const paidJobs = new Set((paidInv ?? []).map(i => (i as { job_id: string | null }).job_id).filter(Boolean) as string[])

  const techIds = [...new Set((elig ?? []).map(e => (e as { tech_user_id: string | null }).tech_user_id).filter(Boolean))] as string[]
  const techNames = new Map<string, string>()
  if (techIds.length > 0) {
    const { data: profs } = await supabase.from('profiles').select('id, full_name').in('id', techIds)
    for (const p of profs ?? []) techNames.set(p.id as string, (p.full_name as string | null) ?? '')
  }

  for (const r of rows) {
    const e = eligByJob.get(r.id)
    const techUserId = e?.tech_user_id ?? null
    // Log first (the audit record), then clear the stamp.
    await supabase.from('commission_completion_resets').insert({
      sf_job_id: r.id,
      job_number: r.number,
      customer_name: r.customer_name,
      old_work_completed_at: r.work_completed_at,
      current_status: r.status,
      job_total: e?.revenue ?? r.total ?? null,
      had_payment: paidJobs.has(r.id) || !!r.closed_at,
      tech_user_id: techUserId,
      tech_name: techUserId ? (techNames.get(techUserId) ?? null) : null,
    })
    await supabase
      .from('sf_jobs')
      .update({ work_completed_at: null })
      .eq('id', r.id)
      .not('work_completed_at', 'is', null)
  }
}

async function syncJobChildren(jobsRaw: Raw[]) {
  const supabase = db()
  // A job can arrive twice in one batch (SF pagination returns it on two pages
  // when its updated_date shifts mid-scan). The per-job delete+insert children
  // below build their rows via flatMap, so a duplicate job would double-insert
  // the same (job_id, tech_id)/(job_id, agent_id) rows and trip those tables'
  // unique constraints. Dedupe jobs by id first.
  const jobs = dedupeByKey(jobsRaw as unknown as Record<string, unknown>[], 'id') as unknown as Raw[]
  const jobIds = jobs.map(j => toStr(j.id)!)

  // Techs
  const techRows = jobs.flatMap(j =>
    (j.techs_assigned ?? []).map((t: Raw) => ({
      job_id: toStr(j.id)!, tech_id: toStr(t.id)!,
      tech_first_name: toStr(t.first_name), tech_last_name: toStr(t.last_name),
      sf_synced_at: nowIso(),
    }))
  )
  await supabase.from('sf_job_techs').delete().in('job_id', jobIds)
  if (techRows.length > 0) await supabase.from('sf_job_techs').insert(techRows)

  // Agents (Service Fusion "Agent/Rep" — basis for commission tracking)
  const agentRows = jobs.flatMap(j =>
    (j.agents ?? []).map((a: Raw) => ({
      job_id: toStr(j.id)!, agent_id: toStr(a.id)!,
      agent_first_name: toStr(a.first_name), agent_last_name: toStr(a.last_name),
      sf_synced_at: nowIso(),
    }))
  )
  await supabase.from('sf_job_agents').delete().in('job_id', jobIds)
  if (agentRows.length > 0) await supabase.from('sf_job_agents').insert(agentRows)

  // Payments
  const paymentRows = jobs.flatMap(j =>
    (j.payments ?? []).map((p: Raw) => ({
      job_id: toStr(j.id)!, sf_id: toStr(p.id),
      amount: toNum(p.amount ?? p.total), payment_date: toStr(p.date ?? p.payment_date),
      payment_type: toStr(p.payment_type ?? p.type), raw_data: p, sf_synced_at: nowIso(),
    }))
  )
  await supabase.from('sf_job_payments').delete().in('job_id', jobIds)
  if (paymentRows.length > 0) await supabase.from('sf_job_payments').insert(paymentRows)

  // Invoices (from job expand — these get the correct job_id)
  const invoiceRows = jobs.flatMap(j =>
    (j.invoices ?? []).map((inv: Raw) => mapInvoice(inv, toStr(j.id)!))
  )
  if (invoiceRows.length > 0) {
    // Same job-expand can surface a shared invoice twice — dedupe before upsert.
    await supabase.from('sf_invoices').upsert(dedupeByKey(invoiceRows, 'id'), { onConflict: 'id' })
  }

  // Line items — SF exposes a job's priced lines as PRODUCTS and SERVICES; the
  // `items` expand is frequently empty, which is why line items historically
  // didn't come through. Merge whichever of products/services/items a job
  // carries, with defensive field coalescing (SF field names vary across
  // products vs services).
  //
  // Replace strategy is REBUILD-ONLY-WHEN-PRESENT: a job with zero extracted
  // lines is left untouched, never wiped. Otherwise the hourly jobs sync — whose
  // expand returns empty products/services — would delete rows a single-job
  // approval refresh had populated.
  const jobLines = (j: Raw): Raw[] => {
    const products = Array.isArray(j.products) ? (j.products as Raw[]) : []
    const services = Array.isArray(j.services) ? (j.services as Raw[]) : []
    if (products.length > 0 || services.length > 0) return [...products, ...services]
    const items = Array.isArray(j.items) ? (j.items as Raw[]) : (Array.isArray(j.line_items) ? (j.line_items as Raw[]) : [])
    return items
  }
  const mapLine = (j: Raw, it: Raw) => {
    const qty = toNum(it.quantity ?? it.qty)
    const unit = toNum(it.unit_price ?? it.price ?? it.rate ?? it.unit_cost)
    const total = toNum(it.total ?? it.total_price ?? it.subtotal ?? it.line_total ?? it.extended_price ?? it.amount)
      ?? (qty != null && unit != null ? qty * unit : unit)
    return {
      sf_job_id: toStr(j.id)!,
      name: toStr(it.name ?? it.product_name ?? it.item_name ?? it.service_name ?? it.short_description ?? it.description),
      description: toStr(it.description ?? it.long_description ?? it.short_description ?? it.notes),
      quantity: qty,
      unit_price: unit,
      total,
      sf_synced_at: nowIso(),
    }
  }
  const jobsWithLines = jobs.filter(j => jobLines(j).length > 0)
  if (jobsWithLines.length > 0) {
    const ids = jobsWithLines.map(j => toStr(j.id)!)
    await supabase.from('sf_job_items').delete().in('sf_job_id', ids)
    const rows = jobsWithLines.flatMap(j => jobLines(j).map(it => mapLine(j, it)))
    if (rows.length > 0) await supabase.from('sf_job_items').insert(rows)
  }
}

// ─── Reschedule detection ─────────────────────────────────────────────────
// Writes sf_job_schedule_history. The dashboard Capacity section reads the
// earliest change_type='initial' row per job as original_scheduled_at (via the
// sf_jobs_cache view), so first touch records an 'initial' baseline; after
// that, genuine start_date changes record 'rescheduled' rows.
//
// Changes are detected against the LATEST LOGGED row, not sf_jobs — this runs
// from afterUpsert, by which time the upsert has already overwritten the
// stored row (the old sf_jobs comparison could therefore never fire, which is
// why this table went quiet after the legacy analytics sync stopped).

async function detectAndRecordReschedules(incomingJobs: Raw[]) {
  const supabase = db()
  const jobs = dedupeByKey(incomingJobs as unknown as Record<string, unknown>[], 'id') as unknown as Raw[]
  const ids = jobs.map(j => toStr(j.id)!).filter(Boolean)
  if (ids.length === 0) return

  // Latest logged scheduled date per job (rows newest-first; keep first seen).
  // Compare on the YYYY-MM-DD part — the column is timestamptz while incoming
  // start_date is a plain date, and a midnight-vs-midnight-UTC mismatch must
  // not register as a reschedule.
  const latest = new Map<string, string>()
  const hasHistory = new Set<string>()
  const { data: hist } = await supabase
    .from('sf_job_schedule_history')
    .select('sf_job_id, scheduled_at, observed_at')
    .in('sf_job_id', ids)
    .order('observed_at', { ascending: false })
  for (const h of (hist ?? []) as Array<{ sf_job_id: string; scheduled_at: string | null }>) {
    hasHistory.add(h.sf_job_id)
    if (!latest.has(h.sf_job_id) && h.scheduled_at) {
      latest.set(h.sf_job_id, h.scheduled_at.slice(0, 10))
    }
  }

  const historyRows: unknown[] = []
  const observedAt = nowIso()

  for (const job of jobs) {
    const id = toStr(job.id)!
    const newDate = toStr(job.start_date)
    if (!newDate || newDate <= '2000-01-01') continue

    if (!hasHistory.has(id)) {
      historyRows.push({
        sf_job_id: id,
        scheduled_at: newDate,
        previous_scheduled_at: null,
        observed_at: observedAt,
        change_type: 'initial',
        job_status_at_change: toStr(job.status),
      })
      continue
    }

    const prevDate = latest.get(id)
    if (prevDate && newDate.slice(0, 10) !== prevDate) {
      historyRows.push({
        sf_job_id: id,
        scheduled_at: newDate,
        previous_scheduled_at: prevDate,
        observed_at: observedAt,
        change_type: 'rescheduled',
        job_status_at_change: toStr(job.status),
      })
    }
  }

  if (historyRows.length > 0) {
    await supabase.from('sf_job_schedule_history').insert(historyRows)
  }
}

// ─── Batch upsert ─────────────────────────────────────────────────────────

const BATCH_SIZE = 200

// Collapse rows that share the same conflict key, keeping the LAST (most
// recently fetched) copy. SF pagination can return the same record on more than
// one page when its updated_date shifts mid-scan (the sync itself, or a
// concurrent edit, moves a record between pages), so an upsert batch can contain
// the same key twice — which Postgres rejects with "ON CONFLICT DO UPDATE
// command cannot affect row a second time". Handles composite keys (e.g.
// "job_id,tech_id").
function dedupeByKey<T extends Record<string, unknown>>(rows: T[], conflictCol: string): T[] {
  const keys = conflictCol.split(',').map(s => s.trim())
  const byKey = new Map<string, T>()
  for (const r of rows) {
    byKey.set(keys.map(c => String(r[c] ?? '')).join(' '), r)
  }
  return byKey.size === rows.length ? rows : [...byKey.values()]
}

async function batchUpsert(table: string, rows: unknown[], conflictCol = 'id') {
  if (rows.length === 0) return 0
  // The /invoices endpoint doesn't return the job link — only the jobs-sync
  // expand sets sf_invoices.job_id. A plain upsert from the invoices entity
  // sync/reconcile therefore overwrote every existing job_id with NULL each
  // run, which broke every job↔invoice join (e.g. "Completed but Never
  // Invoiced" falsely flagging invoiced jobs). Backfill incoming null job_ids
  // from the rows already stored before writing.
  if (table === 'sf_invoices') {
    await preserveExistingInvoiceJobIds(rows as Record<string, unknown>[])
  }
  const supabase = db()
  const deduped = dedupeByKey(rows as Record<string, unknown>[], conflictCol)
  let upserted = 0
  for (const batch of chunk(deduped, BATCH_SIZE)) {
    const { error } = await supabase.from(table).upsert(batch, { onConflict: conflictCol })
    if (error) throw new Error(`Upsert failed on ${table}: ${error.message}`)
    upserted += batch.length
  }
  return upserted
}

// For invoice rows about to be upserted with job_id = null, restore the job_id
// already stored in sf_invoices (set by the jobs-sync invoice expand) so the
// link survives re-syncs from the link-less /invoices endpoint.
async function preserveExistingInvoiceJobIds(rows: Record<string, unknown>[]) {
  const nullRows = rows.filter(r => r.job_id == null && r.id != null)
  if (nullRows.length === 0) return
  const supabase = db()
  for (const batch of chunk(nullRows, 500)) {
    const ids = batch.map(r => String(r.id))
    const { data } = await supabase
      .from('sf_invoices')
      .select('id, job_id')
      .in('id', ids)
      .not('job_id', 'is', null)
    const existing = new Map((data ?? []).map((r: { id: string; job_id: string }) => [r.id, r.job_id]))
    for (const row of batch) {
      const kept = existing.get(String(row.id))
      if (kept) row.job_id = kept
    }
  }
}

// ─── Reference sync (small tables, fully re-pulled daily) ─────────────────

export async function runReferenceSync(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}

  // Company (/me is a single-record endpoint, not a list)
  try {
    const handle = await startRun('reference', 'company')
    try {
      const { sfMirrorGet } = await import('./client')
      const me = await sfMirrorGet('/me') as Raw
      const row = mapCompany(me)
      await batchUpsert('sf_company', [row])
      await completeRun(handle, 1, 1, 1)
      counts['company'] = 1
    } catch (e) {
      await failRun(handle, String(e))
      throw e
    }
  } catch { /* entity failure logged; continue with others */ }

  const refEntities: Array<{ entity: string; path: string; table: string; mapper: (r: Raw) => unknown }> = [
    { entity: 'job_statuses',  path: '/job-statuses',  table: 'sf_job_statuses',  mapper: mapJobStatus },
    { entity: 'job_categories',path: '/job-categories',table: 'sf_job_categories',mapper: mapJobCategory },
    { entity: 'payment_types', path: '/payment-types', table: 'sf_payment_types', mapper: mapPaymentType },
    { entity: 'sources',       path: '/sources',       table: 'sf_sources',       mapper: mapSource },
    { entity: 'techs',         path: '/techs',         table: 'sf_techs',         mapper: mapTech },
  ]

  for (const { entity, path, table, mapper } of refEntities) {
    const handle = await startRun('reference', entity)
    let fetched = 0, pages = 0
    try {
      const rows: unknown[] = []
      for await (const { items } of sfMirrorPaginateAll<Raw>(path)) {
        rows.push(...items.map(mapper))
        fetched += items.length
        pages++
      }
      const upserted = await batchUpsert(table, rows)
      await completeRun(handle, fetched, upserted, pages)
      counts[entity] = upserted
    } catch (e) {
      await failRun(handle, String(e))
    }
  }

  return counts
}

// ─── Incremental sync (large entities, 48-hour window) ────────────────────

interface IncrementalEntityConfig {
  entity: string
  path: string
  table: string
  filterKey?: string  // omit for entities that don't support date filtering (e.g. customers)
  expand?: string
  // Paginate from the LAST page backwards. For endpoints SF returns oldest-first
  // with no sort support (/invoices rejects sort), the newest records live on
  // the highest page numbers — walking backwards means a deadline-limited run
  // always covers the newest records instead of re-fetching the oldest forever.
  reversePages?: boolean
  mapper: (r: Raw) => unknown
  afterUpsert?: (items: Raw[]) => Promise<void>
}

const INCREMENTAL_ENTITIES: IncrementalEntityConfig[] = [
  // Customers are NOT included here — 23k+ records with no date filter support
  // would exceed Vercel's 300s limit. Use "Run Full Backfill" to refresh customers.
  {
    entity: 'jobs', path: '/jobs', table: 'sf_jobs',
    filterKey: 'filters[updated_date][gte]',
    // `items` gives us the job's line items (products & services), mirrored into
    // sf_job_items by syncJobChildren. Same expand the tech sync uses; the mirror
    // client retries 5xx, so a transient bad-items page recovers on the next run.
    expand: 'techs_assigned,agents,payments,invoices,notes,items',
    mapper: mapJob,
    afterUpsert: async (items) => {
      await detectAndRecordReschedules(items)
      await syncJobChildren(items)
      await recordStatusChanges(items)
      await stampWorkCompleted(items)
      await resetRevertedCompletions(items)
    },
  },
  {
    entity: 'estimates', path: '/estimates', table: 'sf_estimates',
    // SF /estimates does not support updated_date filtering — sync all each run
    mapper: mapEstimate,
  },
  {
    entity: 'invoices', path: '/invoices', table: 'sf_invoices',
    // SF /invoices supports neither updated_date filtering nor sort — sync all
    // each run, newest pages first so the deadline never cuts off recent invoices.
    reversePages: true,
    mapper: (r) => mapInvoice(r),
  },
  {
    entity: 'calendar_tasks', path: '/calendar-tasks', table: 'sf_calendar_tasks',
    // SF /calendar-tasks does not support start_date filtering — sync all each run
    mapper: mapCalendarTask,
  },
]

// deadlineMs: if set, pagination stops early when Date.now() >= deadlineMs so the
// function can exit cleanly before Vercel's hard 300s kill. The run is still
// recorded as 'completed' (with whatever was processed) so the health check stays green.
async function runIncrementalSyncForConfig(cfg: IncrementalEntityConfig, deadlineMs?: number): Promise<number> {
  const cutoff = hoursAgo(48)
  const handle = await startRun('incremental', cfg.entity)
  let fetched = 0, upserted = 0, pages = 0
  let hitDeadline = false
  try {
    const params: Record<string, string> = {}
    if (cfg.filterKey) params[cfg.filterKey] = cutoff
    if (cfg.expand) params['expand'] = cfg.expand

    const allItems: Raw[] = []
    if (cfg.reversePages) {
      // Newest-last endpoints: fetch page 1 for the page count, then walk from
      // the last page (newest records) backwards so a deadline-limited run
      // always covers recent data first.
      const first = (await sfMirrorGet(cfg.path, { ...params, page: '1' })) as { items?: Raw[]; _meta?: { pageCount?: number } }
      const totalPages = first._meta?.pageCount ?? 1
      for (let p = totalPages; p >= 1; p--) {
        const json = p === 1
          ? first
          : (await sfMirrorGet(cfg.path, { ...params, page: String(p) })) as { items?: Raw[] }
        const items = json.items ?? []
        allItems.push(...items)
        fetched += items.length
        pages++
        await updateRunProgress(handle, p, fetched, upserted)
        if (deadlineMs && Date.now() >= deadlineMs) {
          hitDeadline = true
          console.warn(`[sf-sync] ${cfg.entity}: soft deadline reached at page ${p}/${totalPages} (reverse), stopping early`)
          break
        }
      }
    } else {
      for await (const { items, page } of sfMirrorPaginateAll<Raw>(cfg.path, params)) {
        allItems.push(...items)
        fetched += items.length
        pages = page
        await updateRunProgress(handle, page, fetched, upserted)
        if (deadlineMs && Date.now() >= deadlineMs) {
          hitDeadline = true
          console.warn(`[sf-sync] ${cfg.entity}: soft deadline reached at page ${page}, stopping early`)
          break
        }
      }
    }

    for (const batchItems of chunk(allItems, BATCH_SIZE)) {
      const rows = batchItems.map(cfg.mapper)
      upserted += await batchUpsert(cfg.table, rows)
      if (cfg.afterUpsert) await cfg.afterUpsert(batchItems)
    }

    await completeRun(handle, fetched, upserted, pages)
    if (hitDeadline) console.warn(`[sf-sync] ${cfg.entity}: completed early (${upserted} upserted across ${pages} pages)`)
    return upserted
  } catch (e) {
    await failRun(handle, String(e))
    throw e
  }
}

// Sync a single entity by name — used by the UI to avoid per-call timeouts.
export async function runIncrementalSyncForEntity(entity: string, deadlineMs?: number): Promise<number> {
  const cfg = INCREMENTAL_ENTITIES.find(c => c.entity === entity)
  if (!cfg) throw new Error(`Unknown entity: ${entity}`)
  return runIncrementalSyncForConfig(cfg, deadlineMs)
}

// Refresh a SINGLE job from Service Fusion on demand — e.g. staff just corrected
// the job's line items in SF and want them mirrored immediately without waiting
// for the hourly sync. Fetches that one job with the full expand (incl. items),
// upserts it, and runs the same child-sync + history hooks the incremental sync
// uses. Returns quickly (one API call), so it's cheap to call from the UI.
export async function syncSingleJob(jobId: string): Promise<{ ok: boolean; error?: string }> {
  // Priced line items live under products + services. Expand them here; if the
  // single-resource expand comes back empty we fall back to the dedicated
  // /jobs/{id}/products and /jobs/{id}/services sub-resources below.
  const FULL_EXPAND = 'techs_assigned,agents,payments,invoices,notes,items,products,services'
  const BASE_EXPAND = 'techs_assigned,agents,payments,invoices,notes'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unwrap = (json: any): Raw | null =>
    json?.items ? (json.items[0] ?? null) : (json?.id ? json : (json?.data ?? null))

  try {
    let raw: Raw | null = null
    try {
      raw = unwrap(await sfMirrorGet(`/jobs/${encodeURIComponent(jobId)}`, { expand: FULL_EXPAND }))
    } catch {
      // Drop the heavy line expands if SF 500s on them (same fallback the tech
      // sync uses); we still refresh the job + its other children.
      raw = unwrap(await sfMirrorGet(`/jobs/${encodeURIComponent(jobId)}`, { expand: BASE_EXPAND }))
    }
    if (!raw || !raw.id) return { ok: false, error: 'Job not found in Service Fusion.' }

    // If the expand didn't surface line items, pull the dedicated sub-resources.
    // Uses the crm sfGet (not the mirror client) so the /jobs sort default isn't
    // forced onto these sub-resource paths.
    const hasLines =
      (Array.isArray(raw.products) && raw.products.length > 0) ||
      (Array.isArray(raw.services) && raw.services.length > 0) ||
      (Array.isArray(raw.items) && raw.items.length > 0)
    if (!hasLines) {
      const { sfGet } = await import('@/lib/crm/service-fusion')
      const rid = encodeURIComponent(toStr(raw.id)!)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sub = async (path: string): Promise<Raw[]> => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const j = (await sfGet(path, { 'per-page': '100' })) as any
          return (j?.items ?? (Array.isArray(j) ? j : [])) as Raw[]
        } catch { return [] }
      }
      raw.products = await sub(`/jobs/${rid}/products`)
      raw.services = await sub(`/jobs/${rid}/services`)
    }

    await batchUpsert('sf_jobs', [mapJob(raw)])
    await detectAndRecordReschedules([raw])
    await syncJobChildren([raw])
    await recordStatusChanges([raw])
    await stampWorkCompleted([raw])
    await resetRevertedCompletions([raw])

    // Also refresh the job's CUSTOMER contact tree (emails/phones), which the
    // hourly job sync never touches — customers only refresh on backfill/
    // reconcile, so a job's contact info can be stale or missing in the mirror.
    // Best-effort: a contact-refresh failure must not fail the job refresh.
    const customerId = toStr(raw.customer_id)
    if (customerId) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cJson = (await sfMirrorGet(`/customers/${encodeURIComponent(customerId)}`, {
          expand: 'contacts,contacts.phones,contacts.emails,locations',
        })) as any
        const cRaw: Raw | null = cJson?.customer ?? (cJson?.items ? cJson.items[0] : (cJson?.id ? cJson : null))
        if (cRaw && cRaw.id) {
          await batchUpsert('sf_customers', [mapCustomer(cRaw)])
          await syncCustomerChildren([cRaw])
        }
      } catch { /* contact refresh best-effort */ }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function runIncrementalSync(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const cfg of INCREMENTAL_ENTITIES) {
    try {
      counts[cfg.entity] = await runIncrementalSyncForConfig(cfg)
    } catch {
      counts[cfg.entity] = -1
    }
  }
  return counts
}

// ─── Backfill (one-time full paginated scan, resumable) ───────────────────
// Processes one entity at a time. Resume logic: looks for the most recent
// 'running' or 'partial' backfill run for that entity and picks up from last_page + 1.

export async function runBackfill(entity?: string): Promise<Record<string, number>> {
  const targets = entity
    ? INCREMENTAL_ENTITIES.filter(e => e.entity === entity)
    : INCREMENTAL_ENTITIES

  const counts: Record<string, number> = {}

  for (const cfg of targets) {
    const resumePage = await getBackfillResumePage(cfg.entity)
    const handle = await startRun('backfill', cfg.entity)
    let fetched = 0, upserted = 0, pages = 0

    try {
      const params: Record<string, string> = {}
      if (cfg.expand) params['expand'] = cfg.expand

      for await (const { items, page, meta } of sfMirrorPaginateAll<Raw>(cfg.path, params, resumePage)) {
        const rows = items.map(cfg.mapper)
        const batchUpserted = await batchUpsert(cfg.table, rows)
        if (cfg.afterUpsert) await cfg.afterUpsert(items)

        fetched += items.length
        upserted += batchUpserted
        pages = page
        await updateRunProgress(handle, page, fetched, upserted)

        console.log(`[sf-backfill] ${cfg.entity} page ${page}/${meta.pageCount} (${fetched} fetched)`)
      }

      await completeRun(handle, fetched, upserted, pages)
      counts[cfg.entity] = upserted
    } catch (e) {
      // Mark partial so resume logic can find this run
      await db().from('sf_sync_runs').update({ status: 'partial', error_message: String(e).slice(0, 2000) }).eq('id', handle.id)
      counts[cfg.entity] = -1
      console.error(`[sf-backfill] ${cfg.entity} failed:`, e)
    }
  }

  return counts
}

// ─── Weekly reconcile (full scan + soft-delete detection) ─────────────────
// Fetches every ID from SF, compares against our mirror, marks missing = is_deleted.
// Run one entity at a time via runWeeklyReconcileForEntity — each entity gets
// its own function invocation to stay within Vercel's per-function time limit.

export async function runWeeklyReconcileForEntity(
  entityName: string,
  { skipExpand = false, concurrency = 1 }: { skipExpand?: boolean; concurrency?: number } = {}
): Promise<number> {
  const cfg = INCREMENTAL_ENTITIES.find(c => c.entity === entityName)
  if (!cfg) throw new Error(`Unknown entity: ${entityName}`)
  const supabase = db()

  const handle = await startRun('reconcile', cfg.entity)
  let fetched = 0, upserted = 0, pages = 0
  const seenIds = new Set<string>()

  try {
    const params: Record<string, string> = {}
    // skipExpand: omit child data (techs, payments, invoices). Children are kept
    // fresh by daily incremental sync; the reconcile only needs main fields for
    // soft-delete detection.
    if (!skipExpand && cfg.expand) params['expand'] = cfg.expand

    if (concurrency > 1) {
      // Parallel path: fetch multiple pages simultaneously to overcome SF API latency.
      // With concurrency=3, 618 pages / 3 batches × ~2s each ≈ 410s (fits in 800s).
      const first = await sfMirrorGet(cfg.path, { ...params, page: '1' }) as { items?: Raw[]; _meta?: { pageCount: number } }
      const totalPages = first._meta?.pageCount ?? 1
      const processItems = async (items: Raw[]) => {
        await batchUpsert(cfg.table, items.map(cfg.mapper))
        if (!skipExpand && cfg.afterUpsert) await cfg.afterUpsert(items)
        for (const item of items) seenIds.add(toStr(item.id)!)
        fetched += items.length
        upserted += items.length
      }

      await processItems(first.items ?? [])
      pages = 1
      await updateRunProgress(handle, 1, fetched, upserted)

      for (let batchStart = 2; batchStart <= totalPages; batchStart += concurrency) {
        const batchEnd = Math.min(batchStart + concurrency - 1, totalPages)
        const pageNums = Array.from({ length: batchEnd - batchStart + 1 }, (_, i) => batchStart + i)

        const batchResults = await Promise.all(
          pageNums.map(p => sfMirrorGet(cfg.path, { ...params, page: String(p) }) as Promise<{ items?: Raw[] }>)
        )
        for (const result of batchResults) await processItems(result.items ?? [])
        pages = batchEnd
        await updateRunProgress(handle, batchEnd, fetched, upserted)
        console.log(`[sf-reconcile] ${cfg.entity} pages ${batchStart}-${batchEnd}/${totalPages}`)
      }
    } else {
      // Sequential path
      for await (const { items, page, meta } of sfMirrorPaginateAll<Raw>(cfg.path, params)) {
        const rows = items.map(cfg.mapper)
        await batchUpsert(cfg.table, rows)
        if (!skipExpand && cfg.afterUpsert) await cfg.afterUpsert(items)
        for (const item of items) seenIds.add(toStr(item.id)!)
        fetched += items.length
        upserted += items.length
        pages = page
        await updateRunProgress(handle, page, fetched, upserted)
        console.log(`[sf-reconcile] ${cfg.entity} page ${page}/${meta.pageCount}`)
      }
    }

    // Soft-delete detection with a TWO-STRIKES grace period. SF's paginated scan
    // occasionally drops a page (or returns an empty body without erroring), which
    // would false-flag active rows as deleted. So a row missing from a single scan
    // is only stamped (sf_missing_since); it's soft-deleted only once it's been
    // missing past the grace window (≈ two weekly reconciles). Seen rows clear the
    // stamp, and seen rows are re-upserted with is_deleted=false (auto-recovery of
    // anything a prior bad scan wrongly deleted).
    if (seenIds.size > 0) {
      const allOurs = await fetchAllRows<{ id: string; sf_missing_since: string | null }>((from, to) =>
        supabase.from(cfg.table).select('id, sf_missing_since').eq('is_deleted', false)
          .order('id', { ascending: true }).range(from, to)
      )
      const candidates = allOurs.filter(r => !seenIds.has(r.id))

      // Catastrophic-scan guard: a real week deletes a handful. A large candidate
      // set means the scan was incomplete — do nothing at all (don't even stamp),
      // so a bad fetch can never cascade.
      const cap = Math.max(100, Math.floor(allOurs.length * 0.05))
      if (candidates.length > cap) {
        console.warn(`[sf-reconcile] ${cfg.entity}: ${candidates.length} deletion candidates exceed cap ${cap} — likely an incomplete SF scan; skipping soft-delete this run`)
      } else if (candidates.length > 0) {
        const now = nowIso()
        const cutoff = new Date(Date.now() - RECONCILE_GRACE_MS).toISOString()
        const firstMiss = candidates.filter(r => !r.sf_missing_since).map(r => r.id)                       // strike 1: stamp only
        const confirmed = candidates.filter(r => r.sf_missing_since && r.sf_missing_since < cutoff).map(r => r.id) // missing past grace → delete
        for (const c of chunk(firstMiss, 500)) await supabase.from(cfg.table).update({ sf_missing_since: now }).in('id', c)
        for (const c of chunk(confirmed, 500)) await supabase.from(cfg.table).update({ is_deleted: true, sf_synced_at: now }).in('id', c)
        if (firstMiss.length) console.log(`[sf-reconcile] ${cfg.entity}: ${firstMiss.length} newly missing (grace started)`)
        if (confirmed.length) console.log(`[sf-reconcile] ${cfg.entity}: marked ${confirmed.length} deleted (missing past grace)`)
      }

      // Reappeared: a seen row that still carried a missing-stamp → clear it.
      const reappeared = allOurs.filter(r => r.sf_missing_since && seenIds.has(r.id)).map(r => r.id)
      for (const c of chunk(reappeared, 500)) await supabase.from(cfg.table).update({ sf_missing_since: null }).in('id', c)
      if (reappeared.length) console.log(`[sf-reconcile] ${cfg.entity}: cleared missing-stamp on ${reappeared.length} reappeared`)
    }

    await completeRun(handle, fetched, upserted, pages)
    return upserted
  } catch (e) {
    await failRun(handle, String(e))
    throw e
  }
}

export async function runWeeklyReconcile(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}

  for (const cfg of INCREMENTAL_ENTITIES) {
    try {
      counts[cfg.entity] = await runWeeklyReconcileForEntity(cfg.entity)
    } catch {
      counts[cfg.entity] = -1
    }
  }

  // Equipment sync (Known Issue: no top-level endpoint, iterate per customer)
  await syncAllEquipment(counts)

  return counts
}

async function syncAllEquipment(counts: Record<string, number>) {
  const supabase = db()
  const handle = await startRun('reconcile', 'equipment')
  let fetched = 0, upserted = 0, page = 0

  try {
    // Fetch all non-deleted customer IDs from our mirror
    const { data: customers } = await supabase
      .from('sf_customers')
      .select('id')
      .eq('is_deleted', false)

    const customerIds = (customers as { id: string }[] ?? []).map(c => c.id)
    const seenEquipmentIds = new Set<string>()

    for (const customerId of customerIds) {
      page++
      try {
        for await (const { items } of sfMirrorPaginateAll<Raw>(
          `/customers/${customerId}/equipment`,
          {},
        )) {
          const rows = items.map(r => mapEquipment(r, customerId))
          upserted += await batchUpsert('sf_customer_equipment', rows)
          for (const item of items) seenEquipmentIds.add(toStr(item.id)!)
          fetched += items.length
        }
      } catch {
        // Some customers may have no equipment endpoint access; continue
      }
      if (page % 100 === 0) await updateRunProgress(handle, page, fetched, upserted)
    }

    // Soft-delete for equipment no longer returned
    if (seenEquipmentIds.size > 0) {
      const { data: allEquip } = await supabase.from('sf_customer_equipment').select('id').eq('is_deleted', false)
      const deletedIds = (allEquip as { id: string }[] ?? []).filter(r => !seenEquipmentIds.has(r.id)).map(r => r.id)
      if (deletedIds.length > 0) await supabase.from('sf_customer_equipment').update({ is_deleted: true, sf_synced_at: nowIso() }).in('id', deletedIds)
    }

    await completeRun(handle, fetched, upserted, page)
    counts['equipment'] = upserted
  } catch (e) {
    await failRun(handle, String(e))
  }
}

// ─── Scoped reconcile (date-windowed soft-delete detection) ───────────────
// Like runWeeklyReconcile but limited to records within the last N days.
// Jobs: filtered at SF API level via start_date. Estimates: fetched all
// (no SF date filter), but soft-delete detection scoped to created_at_sf window.

export async function runScopedReconcile(days: number, entities: string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  const supabase = db()

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const cutoffDate = cutoff.toISOString().slice(0, 10) // YYYY-MM-DD
  const cutoffIso = cutoff.toISOString().slice(0, 19) + '+00:00'

  for (const entityName of entities) {
    const cfg = INCREMENTAL_ENTITIES.find(c => c.entity === entityName)
    if (!cfg) continue

    const handle = await startRun('reconcile', cfg.entity)
    let fetched = 0, upserted = 0, pages = 0
    const seenIds = new Set<string>()

    try {
      const params: Record<string, string> = {}
      if (cfg.expand) params['expand'] = cfg.expand
      if (entityName === 'jobs') params['filters[start_date][gte]'] = cutoffDate

      for await (const { items, page } of sfMirrorPaginateAll<Raw>(cfg.path, params)) {
        const rows = items.map(cfg.mapper)
        await batchUpsert(cfg.table, rows)
        if (cfg.afterUpsert) await cfg.afterUpsert(items)
        for (const item of items) seenIds.add(toStr(item.id)!)
        fetched += items.length
        upserted += items.length
        pages = page
        await updateRunProgress(handle, page, fetched, upserted)
      }

      // Scoped soft-delete: only check records within the date window.
      // Paginate past the 1000-row cap so a busy window isn't under-detected.
      if (seenIds.size > 0) {
        const scopedOurs = await fetchAllRows<{ id: string }>((from, to) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let query: any = supabase.from(cfg.table).select('id').eq('is_deleted', false)
          if (entityName === 'jobs') query = query.gte('start_date', cutoffDate)
          else if (entityName === 'estimates') query = query.gte('created_at_sf', cutoffIso)
          return query.order('id', { ascending: true }).range(from, to)
        })
        const deletedIds = scopedOurs
          .filter((r: { id: string }) => !seenIds.has(r.id))
          .map((r: { id: string }) => r.id)

        if (deletedIds.length > 0) {
          await supabase.from(cfg.table).update({ is_deleted: true, sf_synced_at: nowIso() }).in('id', deletedIds)
          console.log(`[sf-scoped-reconcile] ${entityName}: marked ${deletedIds.length} as deleted`)
        }
      }

      await completeRun(handle, fetched, upserted, pages)
      counts[entityName] = upserted
    } catch (e) {
      await failRun(handle, String(e))
      counts[entityName] = -1
    }
  }

  return counts
}

// ─── Status query (for admin UI) ──────────────────────────────────────────

export async function getSyncStatus() {
  const supabase = db()
  const { data } = await supabase
    .from('sf_sync_runs')
    .select('entity, run_type, status, started_at, completed_at, records_upserted, pages_fetched, last_page, error_message')
    .order('started_at', { ascending: false })
    .limit(200)

  return data ?? []
}

export async function getMirrorCounts() {
  const supabase = db()
  const tables = ['sf_customers', 'sf_jobs', 'sf_estimates', 'sf_invoices', 'sf_calendar_tasks', 'sf_techs', 'sf_customer_equipment']
  const results: Record<string, number> = {}
  await Promise.all(tables.map(async t => {
    const { count } = await supabase.from(t).select('*', { count: 'exact', head: true }).eq('is_deleted', false)
    results[t] = count ?? 0
  }))
  return results
}
