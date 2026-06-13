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
    id: toStr(r.id)!, job_id: jobId ?? toStr(r.job_id) ?? null,
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

async function syncJobChildren(jobs: Raw[]) {
  const supabase = db()
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
    await supabase.from('sf_invoices').upsert(invoiceRows, { onConflict: 'id' })
  }
}

// ─── Reschedule detection ─────────────────────────────────────────────────
// Folded into the daily job sync per §9. Compares incoming start_date against
// the currently stored value; writes sf_job_schedule_history on change.

async function detectAndRecordReschedules(incomingJobs: Raw[]) {
  const supabase = db()
  const ids = incomingJobs.map(j => toStr(j.id)!)

  const { data: existing } = await supabase
    .from('sf_jobs')
    .select('id, start_date, status')
    .in('id', ids)

  if (!existing || existing.length === 0) return

  type ExistingJob = { id: string; start_date: string | null; status: string | null }
  const existingMap = new Map((existing as ExistingJob[]).map(e => [e.id, e]))
  const historyRows: unknown[] = []
  const observedAt = nowIso()

  for (const job of incomingJobs) {
    const id = toStr(job.id)!
    const prev = existingMap.get(id)
    if (!prev) continue

    const newDate = toStr(job.start_date)
    const prevDate = prev.start_date

    if (newDate && prevDate && newDate !== prevDate) {
      historyRows.push({
        sf_job_id: id,
        scheduled_at: newDate,
        previous_scheduled_at: prevDate,
        observed_at: observedAt,
        change_type: 'reschedule',
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

async function batchUpsert(table: string, rows: unknown[], conflictCol = 'id') {
  if (rows.length === 0) return 0
  const supabase = db()
  let upserted = 0
  for (const batch of chunk(rows as Record<string, unknown>[], BATCH_SIZE)) {
    const { error } = await supabase.from(table).upsert(batch, { onConflict: conflictCol })
    if (error) throw new Error(`Upsert failed on ${table}: ${error.message}`)
    upserted += batch.length
  }
  return upserted
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
  mapper: (r: Raw) => unknown
  afterUpsert?: (items: Raw[]) => Promise<void>
}

const INCREMENTAL_ENTITIES: IncrementalEntityConfig[] = [
  // Customers are NOT included here — 23k+ records with no date filter support
  // would exceed Vercel's 300s limit. Use "Run Full Backfill" to refresh customers.
  {
    entity: 'jobs', path: '/jobs', table: 'sf_jobs',
    filterKey: 'filters[updated_date][gte]',
    expand: 'techs_assigned,payments,invoices,notes',
    mapper: mapJob,
    afterUpsert: async (items) => {
      await detectAndRecordReschedules(items)
      await syncJobChildren(items)
    },
  },
  {
    entity: 'estimates', path: '/estimates', table: 'sf_estimates',
    // SF /estimates does not support updated_date filtering — sync all each run
    mapper: mapEstimate,
  },
  {
    entity: 'invoices', path: '/invoices', table: 'sf_invoices',
    // SF /invoices does not support updated_date filtering — sync all each run
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

    // Soft-delete detection: find IDs in our DB not returned by SF.
    // seenIds is the complete set from a fully-paginated SF scan (errors throw
    // before reaching here), so we must read ALL our rows — paginate past the
    // 1000-row cap, or large tables (jobs ~4.5k) would under-detect deletions.
    if (seenIds.size > 0) {
      const allOurs = await fetchAllRows<{ id: string }>((from, to) =>
        supabase.from(cfg.table).select('id').eq('is_deleted', false)
          .order('id', { ascending: true }).range(from, to)
      )

      const deletedIds = allOurs
        .filter(r => !seenIds.has(r.id))
        .map(r => r.id)

      if (deletedIds.length > 0) {
        await supabase.from(cfg.table).update({ is_deleted: true, sf_synced_at: nowIso() }).in('id', deletedIds)
        console.log(`[sf-reconcile] ${cfg.entity}: marked ${deletedIds.length} as deleted`)
      }
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
