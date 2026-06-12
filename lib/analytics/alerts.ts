import { createClient as createAdminClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

function getAdminClient(): SupabaseClient {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

function today(): string { return new Date().toISOString().slice(0, 10) }

// ── Shared helpers ────────────────────────────────────────────────────────────

function daysBetween(dateStr: string): number {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000)
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

  // sf_jobs.closed_at is null for most records (SF API field is completed_date,
  // not closed_at). Use end_date <= today as the "job has completed" proxy.
  const { data } = await db
    .from('sf_jobs')
    .select('id, number, customer_name, customer_id, closed_at, end_date, total, due_total, payment_status, source')
    .not('end_date', 'is', null)
    .lte('end_date', today())
    .gt('due_total', 0)
    .not('status', 'in', '("Cancelled","Void","Voided")')
    .eq('is_deleted', false)
    .order('end_date', { ascending: true })
    .limit(100)

  const jobs = data ?? []
  const jobIds = jobs.map((j: { id: string }) => j.id)
  const techMap = await fetchTechNamesByJobIds(db, jobIds)

  const items: UnpaidJob[] = jobs.map((j: {
    id: string
    number: string | null
    customer_name: string | null
    customer_id: string | null
    closed_at: string | null
    end_date: string | null
    total: number | null
    due_total: number | null
    payment_status: string | null
    source: string | null
  }) => {
    const effectiveDate = j.closed_at ?? j.end_date ?? ''
    return {
      id: j.id,
      number: j.number,
      customer_name: j.customer_name,
      customer_id: j.customer_id,
      closed_at: effectiveDate,
      total: j.total ?? 0,
      due_total: j.due_total ?? 0,
      payment_status: j.payment_status,
      source: j.source ?? null,
      tech_names: techMap.get(j.id) ?? [],
      days_outstanding: daysBetween(effectiveDate),
    }
  })

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

  // Fetch completed jobs — use end_date <= today since closed_at is null for most
  // records (SF API field is completed_date, populated going forward via mapJob fix).
  const { data: closedJobs } = await db
    .from('sf_jobs')
    .select('id, number, customer_name, customer_id, closed_at, end_date, total, source')
    .not('end_date', 'is', null)
    .lte('end_date', today())
    .not('status', 'in', '("Cancelled","Void","Voided","Open","Pending")')
    .not('customer_id', 'is', null)
    .neq('customer_id', '')
    .eq('is_deleted', false)
    .limit(5000)

  const closed = closedJobs ?? []
  if (closed.length === 0) return { items: [], totalUninvoiced: 0 }

  // Fetch all invoice job_ids
  const { data: invoices } = await db
    .from('sf_invoices')
    .select('job_id')
    .not('job_id', 'is', null)
    .eq('is_deleted', false)
    .limit(5000)

  const invoicedJobIds = new Set((invoices ?? []).map((inv: { job_id: string | null }) => inv.job_id).filter(Boolean))

  // Subtract in JS
  const uninvoiced = closed.filter((j: { id: string }) => !invoicedJobIds.has(j.id))

  // Limit to 100
  const limited = uninvoiced.slice(0, 100)
  const jobIds = limited.map((j: { id: string }) => j.id)
  const techMap = await fetchTechNamesByJobIds(db, jobIds)

  const items: UninvoicedJob[] = limited.map((j: {
    id: string
    number: string | null
    customer_name: string | null
    customer_id: string | null
    closed_at: string | null
    end_date: string | null
    total: number | null
    source: string | null
  }) => {
    const effectiveDate = j.closed_at ?? j.end_date ?? ''
    return {
      id: j.id,
      number: j.number,
      customer_name: j.customer_name,
      customer_id: j.customer_id,
      closed_at: effectiveDate,
      total: j.total,
      source: j.source ?? null,
      tech_names: techMap.get(j.id) ?? [],
      days_since_completion: daysBetween(effectiveDate),
    }
  })

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
    .not('status', 'in', '("accepted","declined","Accepted","Declined","Closed")')
    .lt('created_at_sf', fourteenDaysAgo)
    .eq('is_deleted', false)
    .order('created_at_sf', { ascending: true })
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
    .not('status', 'in', '("Cancelled","Void","Voided")')
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

  // 2. Fetch unpaid invoices for those customers
  const { data: invoices } = await db
    .from('sf_invoices')
    .select('id, customer_id, date, payment_terms, total')
    .in('customer_id', customerIds)
    .eq('is_paid', false)
    .eq('is_deleted', false)
    .limit(2000)

  const invList = invoices ?? []
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

// ── Alert 7 — Scheduler Leads Awaiting Manual SF Push ────────────────────────

export interface AwaitingPushLead {
  id: string
  customer_name: string
  service_type: string
  service_category: string
  appointment_date: string
  sync_status: string
  created_at: string
  days_waiting: number
}

export interface AwaitingPushResult {
  items: AwaitingPushLead[]
}

export async function getAwaitingPushLeads(): Promise<AwaitingPushResult> {
  const db = getAdminClient()

  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString()

  const { data } = await db
    .from('scheduler_leads')
    .select('id, customer_first_name, customer_last_name, service_type, service_category, appointment_date, sync_status, created_at')
    .in('sync_status', ['not_attempted', 'sync_failed'])
    .neq('status', 'rejected')
    .gte('created_at', thirtyDaysAgo)
    .order('created_at', { ascending: false })
    .limit(100)

  const items: AwaitingPushLead[] = (data ?? []).map((l: {
    id: string
    customer_first_name: string
    customer_last_name: string
    service_type: string
    service_category: string
    appointment_date: string
    sync_status: string
    created_at: string
  }) => ({
    id: l.id,
    customer_name: [l.customer_first_name, l.customer_last_name].filter(Boolean).join(' '),
    service_type: l.service_type,
    service_category: l.service_category,
    appointment_date: l.appointment_date,
    sync_status: l.sync_status,
    created_at: l.created_at,
    days_waiting: daysBetween(l.created_at),
  }))

  return { items }
}
