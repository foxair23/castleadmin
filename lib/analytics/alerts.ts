import { createClient as createAdminClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

function getAdminClient(): SupabaseClient {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function daysBetween(dateStr: string): number {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000)
}

// Fetch every matching row past PostgREST's 1000-row response cap. `build`
// receives an inclusive [from, to] range and must apply a stable .order() so
// pages don't skip or duplicate rows.
async function fetchAll<T>(
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

async function fetchTechNamesByJobIds(
  db: SupabaseClient,
  jobIds: string[]
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  if (jobIds.length === 0) return map

  const { data } = await db
    .from('sf_job_techs')
    .select('job_id, tech_first_name, tech_last_name')
    .in('job_id', jobIds)
    .limit(jobIds.length * 5)

  for (const row of data ?? []) {
    const name = [row.tech_first_name, row.tech_last_name].filter(Boolean).join(' ')
    const existing = map.get(row.job_id) ?? []
    existing.push(name)
    map.set(row.job_id, existing)
  }
  return map
}

// ── Alert 1 — Completed but Unpaid Jobs ──────────────────────────────────────

export interface UnpaidJob {
  id: string
  number: string | null
  customer_name: string | null
  customer_id: string | null
  closed_at: string
  total: number
  due_total: number
  payment_status: string | null
  source: string | null
  tech_names: string[]
  days_outstanding: number
}

export interface UnpaidJobsResult {
  items: UnpaidJob[]
  totalDue: number
}

export async function getUnpaidJobs(): Promise<UnpaidJobsResult> {
  const db = getAdminClient()

  const { data } = await db
    .from('sf_jobs')
    .select('id, number, customer_name, customer_id, closed_at, total, due_total, payment_status, source')
    .not('closed_at', 'is', null)
    .gt('closed_at', '2000-01-01')  // exclude epoch-zero dates SF stores for cancelled jobs
    .gt('due_total', 0)
    .not('status', 'in', '("Cancelled","Void","Voided")')
    .eq('is_deleted', false)
    .order('closed_at', { ascending: true })
    .limit(100)

  const jobs = data ?? []
  const jobIds = jobs.map((j: { id: string }) => j.id)
  const techMap = await fetchTechNamesByJobIds(db, jobIds)

  const items: UnpaidJob[] = jobs.map((j: {
    id: string
    number: string | null
    customer_name: string | null
    customer_id: string | null
    closed_at: string
    total: number | null
    due_total: number | null
    payment_status: string | null
    source: string | null
  }) => ({
    id: j.id,
    number: j.number,
    customer_name: j.customer_name,
    customer_id: j.customer_id,
    closed_at: j.closed_at,
    total: j.total ?? 0,
    due_total: j.due_total ?? 0,
    payment_status: j.payment_status,
    source: j.source ?? null,
    tech_names: techMap.get(j.id) ?? [],
    days_outstanding: daysBetween(j.closed_at),
  }))

  const totalDue = items.reduce((s, i) => s + i.due_total, 0)
  return { items, totalDue }
}

// ── Alert 2 — Completed but Never Invoiced ───────────────────────────────────

export interface UninvoicedJob {
  id: string
  number: string | null
  customer_name: string | null
  customer_id: string | null
  closed_at: string
  total: number | null
  source: string | null
  tech_names: string[]
  days_since_completion: number
}

export interface UninvoicedJobsResult {
  items: UninvoicedJob[]
  totalUninvoiced: number
}

export async function getUninvoicedJobs(): Promise<UninvoicedJobsResult> {
  const db = getAdminClient()

  // Fetch ALL completed jobs and ALL invoice job_ids, then subtract. Both queries
  // paginate with a stable order('id') because PostgREST caps any single response
  // at 1000 rows — a plain .limit(5000) silently returned only 1000 invoices, so
  // recently-invoiced jobs were wrongly flagged as never invoiced.
  const oneYearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10)

  const closed = await fetchAll<{
    id: string; number: string | null; customer_name: string | null
    customer_id: string | null; closed_at: string; total: number | null; source: string | null
  }>((from, to) =>
    db.from('sf_jobs')
      .select('id, number, customer_name, customer_id, closed_at, total, source')
      .not('closed_at', 'is', null)
      .gte('closed_at', oneYearAgo)
      .not('status', 'in', '("Cancelled","Void","Voided")')
      .eq('is_deleted', false)
      .order('id', { ascending: true })
      .range(from, to)
  )
  if (closed.length === 0) return { items: [], totalUninvoiced: 0 }

  const invoiceRows = await fetchAll<{ job_id: string | null; customer_id: string | null; date: string | null }>((from, to) =>
    db.from('sf_invoices')
      .select('job_id, customer_id, date')
      .eq('is_deleted', false)
      .order('id', { ascending: true })
      .range(from, to)
  )

  // Primary match: invoice has explicit job_id link
  const invoicedJobIds = new Set(invoiceRows.map(inv => inv.job_id).filter(Boolean))

  // Secondary match: invoice linked only by customer_id (job_id NULL — happens when
  // invoices are re-synced via the invoices endpoint without job expand, clearing the
  // job_id that was previously set). Group by customer for fast lookup.
  const invoicesByCustomer = new Map<string, string[]>()
  for (const inv of invoiceRows) {
    if (!inv.customer_id || !inv.date) continue
    const arr = invoicesByCustomer.get(inv.customer_id) ?? []
    arr.push(inv.date.slice(0, 10))
    invoicesByCustomer.set(inv.customer_id, arr)
  }

  // Keep jobs with no invoice, newest completion first, cap at 100.
  const uninvoiced = closed
    .filter(j => {
      if (invoicedJobIds.has(j.id)) return false
      // Secondary: any invoice for same customer within 60 days of closed_at
      if (j.customer_id) {
        const closedYmd = j.closed_at.slice(0, 10)
        const closedMs = new Date(closedYmd).getTime()
        const window = 60 * 86_400_000
        const custInvDates = invoicesByCustomer.get(j.customer_id) ?? []
        if (custInvDates.some(d => Math.abs(new Date(d).getTime() - closedMs) <= window)) return false
      }
      return true
    })
    .sort((a, b) => (b.closed_at ?? '').localeCompare(a.closed_at ?? ''))
  const limited = uninvoiced.slice(0, 100)
  const jobIds = limited.map((j: { id: string }) => j.id)
  const techMap = await fetchTechNamesByJobIds(db, jobIds)

  const items: UninvoicedJob[] = limited.map((j: {
    id: string
    number: string | null
    customer_name: string | null
    customer_id: string | null
    closed_at: string
    total: number | null
    source: string | null
  }) => ({
    id: j.id,
    number: j.number,
    customer_name: j.customer_name,
    customer_id: j.customer_id,
    closed_at: j.closed_at,
    total: j.total,
    source: j.source ?? null,
    tech_names: techMap.get(j.id) ?? [],
    days_since_completion: daysBetween(j.closed_at),
  }))

  const totalUninvoiced = items.reduce((s, i) => s + (i.total ?? 0), 0)
  return { items, totalUninvoiced }
}

// ── Alert 3 — Stale Estimates ─────────────────────────────────────────────────

export interface StaleEstimate {
  id: string
  number: string | null
  customer_name: string | null
  customer_id: string | null
  created_at_sf: string
  total: number | null
  status: string | null
  days_outstanding: number
}

export interface StaleEstimatesResult {
  items: StaleEstimate[]
  totalValue: number
}

export async function getStaleEstimates(): Promise<StaleEstimatesResult> {
  const db = getAdminClient()

  const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000).toISOString()

  const { data } = await db
    .from('sf_estimates')
    .select('id, number, customer_name, customer_id, created_at_sf, total, status')
    // Exclude resolved estimates — stale means "given and never followed up on",
    // so won/lost outcomes don't belong here. SF statuses are freeform text;
    // listing case variants is harmless when a variant doesn't exist.
    .not('status', 'in', '("accepted","declined","Accepted","Declined","Closed","Estimate Won","estimate won","Won","won","Estimate Lost","estimate lost","Lost","lost")')
    .lt('created_at_sf', fourteenDaysAgo)
    .eq('is_deleted', false)
    .order('created_at_sf', { ascending: false })
    .limit(100)

  const items: StaleEstimate[] = (data ?? []).map((e: {
    id: string
    number: string | null
    customer_name: string | null
    customer_id: string | null
    created_at_sf: string
    total: number | null
    status: string | null
  }) => ({
    id: e.id,
    number: e.number,
    customer_name: e.customer_name,
    customer_id: e.customer_id,
    created_at_sf: e.created_at_sf,
    total: e.total,
    status: e.status,
    days_outstanding: daysBetween(e.created_at_sf),
  }))

  const totalValue = items.reduce((s, i) => s + (i.total ?? 0), 0)
  return { items, totalValue }
}

// ── Alert 4 — Jobs Flagged for Follow-Up ─────────────────────────────────────

export interface FollowUpJob {
  id: string
  number: string | null
  customer_name: string | null
  customer_id: string | null
  start_date: string | null
  status: string | null
  source: string | null
  tech_names: string[]
  note_to_customer: string | null
  tech_notes: string | null
  days_open: number
}

export interface FollowUpJobsResult {
  items: FollowUpJob[]
}

export async function getFollowUpJobs(): Promise<FollowUpJobsResult> {
  const db = getAdminClient()

  const { data } = await db
    .from('sf_jobs')
    .select('id, number, customer_name, customer_id, start_date, status, source, note_to_customer, tech_notes')
    .eq('is_requires_follow_up', true)
    .is('closed_at', null)
    .eq('is_deleted', false)
    .order('start_date', { ascending: true })
    .limit(100)

  const jobs = data ?? []
  const jobIds = jobs.map((j: { id: string }) => j.id)
  const techMap = await fetchTechNamesByJobIds(db, jobIds)

  const items: FollowUpJob[] = jobs.map((j: {
    id: string
    number: string | null
    customer_name: string | null
    customer_id: string | null
    start_date: string | null
    status: string | null
    source: string | null
    note_to_customer: string | null
    tech_notes: string | null
  }) => ({
    id: j.id,
    number: j.number,
    customer_name: j.customer_name,
    customer_id: j.customer_id,
    start_date: j.start_date,
    status: j.status,
    source: j.source ?? null,
    tech_names: techMap.get(j.id) ?? [],
    note_to_customer: j.note_to_customer,
    tech_notes: j.tech_notes,
    days_open: j.start_date ? daysBetween(j.start_date) : 0,
  }))

  return { items }
}

// ── Alert 6 — Closed Won Sales Leads Awaiting SF Job ─────────────────────────

export interface AwaitingSfJobLead {
  id: string
  customer_name: string | null
  customer_id: string
  account_number: string | null
  tag_name: string | null
  assigned_rep_name: string | null
  closed_at: string
  days_waiting: number
}

export interface AwaitingSfJobResult {
  items: AwaitingSfJobLead[]
}

export async function getAwaitingSfJob(): Promise<AwaitingSfJobResult> {
  const db = getAdminClient()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: leads } = await (db as any)
    .from('sales_leads')
    .select('id, customer_id, tag_name, assigned_to_user_id, closed_at')
    .eq('closed_outcome', 'won')
    .eq('sf_job_created', false)
    .not('closed_at', 'is', null)
    .order('closed_at', { ascending: true })
    .limit(100)

  const rows = (leads ?? []) as {
    id: string
    customer_id: string
    tag_name: string | null
    assigned_to_user_id: string | null
    closed_at: string
  }[]

  if (rows.length === 0) return { items: [] }

  const customerIds = [...new Set(rows.map(r => r.customer_id))]
  const assigneeIds = [...new Set(rows.map(r => r.assigned_to_user_id).filter(Boolean) as string[])]

  const [customersRes, assigneesRes] = await Promise.all([
    db.from('sf_customers').select('id, customer_name, account_number').in('id', customerIds),
    assigneeIds.length
      ? db.from('profiles').select('id, full_name').in('id', assigneeIds)
      : Promise.resolve({ data: [] }),
  ])

  const customerMap = new Map(
    (customersRes.data ?? []).map((c: { id: string; customer_name: string | null; account_number: string | null }) => [c.id, c])
  )
  const assigneeMap = new Map(
    (assigneesRes.data ?? []).map((p: { id: string; full_name: string }) => [p.id, p.full_name])
  )

  const items: AwaitingSfJobLead[] = rows.map(r => {
    const customer = customerMap.get(r.customer_id)
    return {
      id: r.id,
      customer_id: r.customer_id,
      customer_name: customer?.customer_name ?? null,
      account_number: customer?.account_number ?? null,
      tag_name: r.tag_name,
      assigned_rep_name: r.assigned_to_user_id ? (assigneeMap.get(r.assigned_to_user_id) ?? null) : null,
      closed_at: r.closed_at,
      days_waiting: daysBetween(r.closed_at),
    }
  })

  return { items }
}

export interface OverdueCustomer {
  id: string
  customer_name: string | null
  account_balance: number
  payment_terms: string | null
  oldest_overdue_date: string
  days_overdue: number
  overdue_invoice_count: number
}

export interface OverdueCustomersResult {
  items: OverdueCustomer[]
  totalOverdue: number
}

function parseDueDays(terms: string | null): number {
  if (!terms) return 30
  const t = terms.trim().toLowerCase()
  if (t.includes('receipt') || t.includes('upon') || t.includes('due on')) return 0
  const m = t.match(/(\d+)/)
  return m ? parseInt(m[1]) : 30
}

export async function getOverdueCustomers(): Promise<OverdueCustomersResult> {
  const db = getAdminClient()

  // 1. Fetch customers with balance > 0
  const { data: customers } = await db
    .from('sf_customers')
    .select('id, customer_name, account_balance, payment_terms')
    .gt('account_balance', 0)
    .eq('is_deleted', false)
    .limit(500)

  const custList = customers ?? []
  if (custList.length === 0) return { items: [], totalOverdue: 0 }

  const customerIds = custList.map((c: { id: string }) => c.id)

  // 2. Fetch unpaid invoices for those customers (paginate past the 1000-row cap
  //    so customers with many unpaid invoices aren't undercounted).
  const invList = await fetchAll<{ customer_id: string; date: string; payment_terms: string | null; total: number | null }>((from, to) =>
    db.from('sf_invoices')
      .select('id, customer_id, date, payment_terms, total')
      .in('customer_id', customerIds)
      .eq('is_paid', false)
      .eq('is_deleted', false)
      .order('id', { ascending: true })
      .range(from, to)
  )
  const now = Date.now()

  // Group invoices by customer_id
  const invByCustomer = new Map<string, Array<{ date: string; payment_terms: string | null; total: number | null }>>()
  for (const inv of invList as { customer_id: string; date: string; payment_terms: string | null; total: number | null }[]) {
    const existing = invByCustomer.get(inv.customer_id) ?? []
    existing.push(inv)
    invByCustomer.set(inv.customer_id, existing)
  }

  const items: OverdueCustomer[] = []

  for (const cust of custList as { id: string; customer_name: string | null; account_balance: number; payment_terms: string | null }[]) {
    const custInvoices = invByCustomer.get(cust.id) ?? []

    // Filter to past-due invoices
    const pastDue = custInvoices.filter(inv => {
      const dueDays = parseDueDays(inv.payment_terms)
      const dueAt = new Date(inv.date).getTime() + dueDays * 86_400_000
      return dueAt < now
    })

    if (pastDue.length === 0) continue

    // Find oldest past-due invoice date
    const sortedByDate = [...pastDue].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    const oldest = sortedByDate[0]
    const oldestDueDays = parseDueDays(oldest.payment_terms)
    const oldestDueAt = new Date(oldest.date).getTime() + oldestDueDays * 86_400_000
    const daysOverdue = Math.floor((now - oldestDueAt) / 86_400_000)

    items.push({
      id: cust.id,
      customer_name: cust.customer_name,
      account_balance: cust.account_balance,
      payment_terms: cust.payment_terms,
      oldest_overdue_date: oldest.date,
      days_overdue: daysOverdue,
      overdue_invoice_count: pastDue.length,
    })
  }

  // Sort by days_overdue descending, limit 100
  items.sort((a, b) => b.days_overdue - a.days_overdue)
  const limited = items.slice(0, 100)

  const totalOverdue = limited.reduce((s, i) => s + i.account_balance, 0)
  return { items: limited, totalOverdue }
}

// ── Alert 7 — Online Scheduling Leads Awaiting Acknowledgement ───────────────

export interface OnlineSchedulingLead {
  id: string
  customer_name: string
  service_type: string | null
  service_category: string | null
  appointment_date: string | null
  kind: 'partial' | 'synced'
  sf_job_id: string | null
  created_at: string
  days_waiting: number
}

export interface OnlineSchedulingResult {
  items: OnlineSchedulingLead[]
}

// Leads that have "come in" — either a partial booking was created, or a lead
// synced to Service Fusion — and have NOT yet been acknowledged (Done button).
export async function getOnlineSchedulingLeads(): Promise<OnlineSchedulingResult> {
  const db = getAdminClient()

  const { data } = await db
    .from('scheduler_leads')
    .select('id, customer_first_name, customer_last_name, service_type, service_category, appointment_date, is_partial, synced_at, service_fusion_job_id, created_at')
    .is('acknowledged_at', null)
    .neq('status', 'rejected')
    .or('is_partial.eq.true,synced_at.not.is.null')
    .order('created_at', { ascending: false })
    .limit(200)

  const items: OnlineSchedulingLead[] = (data ?? []).map((l: {
    id: string
    customer_first_name: string | null
    customer_last_name: string | null
    service_type: string | null
    service_category: string | null
    appointment_date: string | null
    is_partial: boolean | null
    synced_at: string | null
    service_fusion_job_id: string | null
    created_at: string
  }) => ({
    id: l.id,
    customer_name: [l.customer_first_name, l.customer_last_name].filter(Boolean).join(' ') || 'Unknown',
    service_type: l.service_type,
    service_category: l.service_category,
    appointment_date: l.appointment_date,
    kind: (l.synced_at ? 'synced' : 'partial') as 'partial' | 'synced',
    sf_job_id: l.service_fusion_job_id ?? null,
    created_at: l.created_at,
    days_waiting: daysBetween(l.created_at),
  }))

  return { items }
}

// ── Alert 8 — Commission Jobs Needing Review (§8.2) ──────────────────────────
// Jobs the commission engine couldn't auto-credit: more than one agent, or an
// agent not yet mapped to a technician. Held out of commission until resolved.

export interface ReviewAgent {
  agent_id: string | null
  name: string
  mapped_tech_user_id: string | null
  mapped_tech_name: string | null
}

export interface CommissionReviewItem {
  id: string                 // commission_job_eligibility.id
  sf_job_id: string
  job_number: string | null
  customer_name: string | null
  recognition_date: string
  revenue: number
  review_reason: 'multiple_agents' | 'unmapped_agent' | null
  agents: ReviewAgent[]
  days_pending: number
}

export interface CommissionReviewResult {
  items: CommissionReviewItem[]
  count: number
  /** Active technicians, for the resolve dropdowns. */
  techs: { id: string; full_name: string }[]
}

export async function getCommissionJobsNeedingReview(): Promise<CommissionReviewResult> {
  const db = getAdminClient()

  const { data: rows } = await db
    .from('commission_job_eligibility')
    .select('id, sf_job_id, recognition_date, revenue, review_reason, created_at')
    .eq('status', 'needs_review')
    .order('created_at', { ascending: true })
    .limit(100)

  const { data: techData } = await db
    .from('profiles')
    .select('id, full_name')
    .eq('role', 'technician').eq('is_active', true)
    .order('full_name')
  const techs = (techData ?? []) as { id: string; full_name: string }[]

  const list = rows ?? []
  if (list.length === 0) return { items: [], count: 0, techs }

  const jobIds = list.map(r => r.sf_job_id)
  const [{ data: jobs }, { data: agents }, { data: maps }] = await Promise.all([
    db.from('sf_jobs').select('id, number, customer_name').in('id', jobIds),
    db.from('sf_job_agents').select('job_id, agent_id, agent_first_name, agent_last_name').in('job_id', jobIds),
    db.from('commission_agent_map').select('tech_user_id, agent_id, agent_first_name, agent_last_name'),
  ])

  const jobMap = new Map((jobs ?? []).map(j => [j.id, j]))
  const techNameById = new Map(techs.map(t => [t.id, t.full_name]))

  // Resolve an agent → mapped tech (by id, then name).
  const mapById = new Map<string, string>()
  const mapByName = new Map<string, string>()
  for (const m of maps ?? []) {
    if (m.agent_id) mapById.set(m.agent_id, m.tech_user_id)
    else if (m.agent_first_name && m.agent_last_name) {
      mapByName.set(`${m.agent_first_name.toLowerCase()}|${m.agent_last_name.toLowerCase()}`, m.tech_user_id)
    }
  }
  function mappedTech(agentId: string | null, first: string | null, last: string | null): string | null {
    if (agentId && mapById.has(agentId)) return mapById.get(agentId)!
    if (first && last) {
      const k = `${first.toLowerCase()}|${last.toLowerCase()}`
      if (mapByName.has(k)) return mapByName.get(k)!
    }
    return null
  }

  const agentsByJob = new Map<string, ReviewAgent[]>()
  for (const a of agents ?? []) {
    const techId = mappedTech(a.agent_id, a.agent_first_name, a.agent_last_name)
    const entry: ReviewAgent = {
      agent_id: a.agent_id,
      name: [a.agent_first_name, a.agent_last_name].filter(Boolean).join(' ') || '(unnamed agent)',
      mapped_tech_user_id: techId,
      mapped_tech_name: techId ? (techNameById.get(techId) ?? null) : null,
    }
    const arr = agentsByJob.get(a.job_id) ?? []
    arr.push(entry)
    agentsByJob.set(a.job_id, arr)
  }

  const items: CommissionReviewItem[] = list.map(r => {
    const job = jobMap.get(r.sf_job_id)
    return {
      id: r.id,
      sf_job_id: r.sf_job_id,
      job_number: job?.number ?? null,
      customer_name: job?.customer_name ?? null,
      recognition_date: r.recognition_date,
      revenue: r.revenue ?? 0,
      review_reason: r.review_reason,
      agents: agentsByJob.get(r.sf_job_id) ?? [],
      days_pending: daysBetween(r.created_at),
    }
  })

  return { items, count: items.length, techs }
}
