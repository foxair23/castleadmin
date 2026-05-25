import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return null
  return user
}

export interface ContactRow {
  customer_id: string
  customer_name: string | null
  email: string | null
  first_name: string | null
  last_name: string | null
  phone: string | null
  city: string | null
  postal_code: string | null
  lead_source: string | null
  last_serviced_date: string | null
  account_balance: number | null
}

function parseDateRange(
  recency: string | null,
  dateFrom: string | null,
  dateTo: string | null,
): { from: string | null; to: string | null } {
  if (dateFrom || dateTo) return { from: dateFrom, to: dateTo }
  if (!recency) return { from: null, to: null }
  if (recency.includes(':')) {
    const [fromStr, toStr] = recency.split(':')
    const fromDays = parseInt(fromStr, 10)
    const toDays = parseInt(toStr, 10)
    if (isNaN(fromDays) || isNaN(toDays)) return { from: null, to: null }
    return {
      from: new Date(Date.now() - toDays * 86_400_000).toISOString().slice(0, 10),
      to: new Date(Date.now() - fromDays * 86_400_000).toISOString().slice(0, 10),
    }
  }
  const days = parseInt(recency, 10)
  if (isNaN(days)) return { from: null, to: null }
  return { from: new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10), to: null }
}

export async function GET(req: NextRequest) {
  const admin = await requireAdmin()
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const recency = searchParams.get('recency')
  const dateFrom = searchParams.get('date_from')
  const dateTo = searchParams.get('date_to')
  const leadSources = searchParams.get('lead_sources')
  const jobCategories = searchParams.get('job_categories')
  const paymentFilter = searchParams.get('payment_filter')

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const dateRange = parseDateRange(recency, dateFrom, dateTo)

  // ── Date pre-filter via sf_jobs.closed_at ────────────────────────────────
  // sf_customers.last_serviced_date is often null in the SF API response.
  // Use the max closed_at from sf_jobs as the authoritative last service date.
  // Only include customers whose MOST RECENT closed job falls in the range —
  // not customers who had any job in the range but came back more recently.
  let dateFilterCustomerIds: string[] | null = null
  if (dateRange.from || dateRange.to) {
    // Get the most recent closed job per customer
    const { data: allClosedJobs } = await db
      .from('sf_jobs')
      .select('customer_id, closed_at')
      .eq('is_deleted', false)
      .not('closed_at', 'is', null)
      .not('customer_id', 'is', null)
      .order('closed_at', { ascending: false })

    // Find max closed_at per customer, then check if it falls in range
    const maxByCustomer = new Map<string, string>()
    for (const j of (allClosedJobs ?? []) as { customer_id: string; closed_at: string }[]) {
      if (!maxByCustomer.has(j.customer_id)) {
        maxByCustomer.set(j.customer_id, j.closed_at)
      }
    }

    const rangeFrom = dateRange.from ? dateRange.from : null
    const rangeTo = dateRange.to ? dateRange.to + 'T23:59:59Z' : null

    dateFilterCustomerIds = []
    for (const [customerId, maxDate] of maxByCustomer) {
      if (rangeFrom && maxDate < rangeFrom) continue
      if (rangeTo && maxDate > rangeTo) continue
      dateFilterCustomerIds.push(customerId)
    }

    if (dateFilterCustomerIds.length === 0) return NextResponse.json({ contacts: [] })
  }

  // ── Job-category pre-filter ──────────────────────────────────────────────
  let categoryCustomerIds: string[] | null = null
  if (jobCategories) {
    const cats = jobCategories.split(',').map(s => s.trim()).filter(Boolean)
    if (cats.length > 0) {
      const { data: catJobs } = await db
        .from('sf_jobs')
        .select('customer_id')
        .in('category', cats)
        .eq('is_deleted', false)
        .not('customer_id', 'is', null)

      categoryCustomerIds = [
        ...new Set((catJobs ?? []).map((j: { customer_id: string | null }) => j.customer_id as string)),
      ]
      if (categoryCustomerIds.length === 0) return NextResponse.json({ contacts: [] })
    }
  }

  // ── Main customer query ──────────────────────────────────────────────────
  let query = db
    .from('sf_customers')
    .select('id, customer_name, referral_source, last_serviced_date, account_balance')
    .eq('is_deleted', false)

  if (leadSources) {
    const sources = leadSources.split(',').map(s => s.trim()).filter(Boolean)
    if (sources.length > 0) query = query.in('referral_source', sources)
  }

  if (paymentFilter === 'outstanding') {
    query = query.gt('account_balance', 0)
  }

  if (dateFilterCustomerIds) {
    query = query.in('id', dateFilterCustomerIds)
  }

  if (categoryCustomerIds) {
    query = query.in('id', categoryCustomerIds)
  }

  const { data: customers, error } = await query.limit(500)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const customerIds = (customers ?? []).map((c: { id: string }) => c.id)
  if (customerIds.length === 0) return NextResponse.json({ contacts: [] })

  // ── Contact, location, and last-service-date enrichment ─────────────────
  // Use explicit separate queries instead of nested selects — PostgREST nested
  // selects can silently return empty arrays with the service role client.
  const [{ data: contactsData }, { data: locationsData }, { data: jobDates }] = await Promise.all([
    db
      .from('sf_customer_contacts')
      .select('id, customer_id, first_name, last_name, is_primary')
      .in('customer_id', customerIds),
    db
      .from('sf_customer_locations')
      .select('customer_id, city, postal_code, is_primary')
      .in('customer_id', customerIds),
    db
      .from('sf_jobs')
      .select('customer_id, closed_at')
      .in('customer_id', customerIds)
      .eq('is_deleted', false)
      .not('closed_at', 'is', null)
      .order('closed_at', { ascending: false }),
  ])

  type RawContact = { id: string; customer_id: string; first_name: string | null; last_name: string | null; is_primary: boolean }
  type RawLocation = { customer_id: string; city: string | null; postal_code: string | null; is_primary: boolean }

  const contactIds = (contactsData ?? []).map((c: RawContact) => c.id)
  const [{ data: emailsData }, { data: phonesData }] = await Promise.all([
    contactIds.length > 0
      ? db.from('sf_contact_emails').select('contact_id, email, is_primary').in('contact_id', contactIds)
      : Promise.resolve({ data: [] }),
    contactIds.length > 0
      ? db.from('sf_contact_phones').select('contact_id, phone, is_primary').in('contact_id', contactIds)
      : Promise.resolve({ data: [] }),
  ])

  type RawEmail = { contact_id: string; email: string | null; is_primary: boolean }
  type RawPhone = { contact_id: string; phone: string | null; is_primary: boolean }

  // Group emails and phones by contact_id
  const emailsByContact = new Map<string, RawEmail[]>()
  for (const e of (emailsData ?? []) as RawEmail[]) {
    const arr = emailsByContact.get(e.contact_id) ?? []
    arr.push(e)
    emailsByContact.set(e.contact_id, arr)
  }
  const phonesByContact = new Map<string, RawPhone[]>()
  for (const p of (phonesData ?? []) as RawPhone[]) {
    const arr = phonesByContact.get(p.contact_id) ?? []
    arr.push(p)
    phonesByContact.set(p.contact_id, arr)
  }

  const contactMap = new Map<string, { first_name: string | null; last_name: string | null; email: string | null; phone: string | null }>()
  for (const c of (contactsData ?? []) as RawContact[]) {
    const existing = contactMap.get(c.customer_id)
    if (existing && !c.is_primary) continue
    const emails = emailsByContact.get(c.id) ?? []
    const phones = phonesByContact.get(c.id) ?? []
    const email = emails.find(e => e.is_primary)?.email ?? emails[0]?.email ?? null
    const phone = phones.find(p => p.is_primary)?.phone ?? phones[0]?.phone ?? null
    contactMap.set(c.customer_id, { first_name: c.first_name ?? null, last_name: c.last_name ?? null, email, phone })
  }

  const locationMap = new Map<string, { city: string | null; postal_code: string | null }>()
  for (const l of (locationsData ?? []) as RawLocation[]) {
    const existing = locationMap.get(l.customer_id)
    if (existing && !l.is_primary) continue
    locationMap.set(l.customer_id, { city: l.city ?? null, postal_code: l.postal_code ?? null })
  }

  // First closed_at per customer (already ordered desc) = most recent
  const lastServiceMap = new Map<string, string>()
  for (const j of (jobDates ?? []) as { customer_id: string; closed_at: string }[]) {
    if (!lastServiceMap.has(j.customer_id)) {
      lastServiceMap.set(j.customer_id, j.closed_at.slice(0, 10))
    }
  }

  type RawCustomer = { id: string; customer_name: string | null; referral_source: string | null; last_serviced_date: string | null; account_balance: number | null }
  const contacts: ContactRow[] = []

  for (const c of (customers ?? []) as RawCustomer[]) {
    const contact = contactMap.get(c.id)
    const location = locationMap.get(c.id)
    if (!contact?.email) continue
    contacts.push({
      customer_id: c.id,
      customer_name: c.customer_name ?? null,
      email: contact.email,
      first_name: contact.first_name,
      last_name: contact.last_name,
      phone: contact.phone ?? null,
      city: location?.city ?? null,
      postal_code: location?.postal_code ?? null,
      lead_source: c.referral_source ?? null,
      last_serviced_date: lastServiceMap.get(c.id) ?? c.last_serviced_date ?? null,
      account_balance: c.account_balance ?? null,
    })
  }

  return NextResponse.json({ contacts })
}
