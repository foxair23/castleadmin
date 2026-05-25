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

export async function GET(req: NextRequest) {
  const admin = await requireAdmin()
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const recency = searchParams.get('recency')            // "days" or "from:to" (days-ago range)
  const dateFrom = searchParams.get('date_from')         // ISO date, custom range start (inclusive)
  const dateTo = searchParams.get('date_to')             // ISO date, custom range end (inclusive)
  const leadSources = searchParams.get('lead_sources')   // comma-separated source names
  const jobCategories = searchParams.get('job_categories') // comma-separated category names
  const paymentFilter = searchParams.get('payment_filter') // "outstanding"

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // ── Job-category pre-filter ──────────────────────────────────────────────
  // Get customer IDs that have jobs in the requested categories (done first
  // so we can pass the ID list into the main customer query).
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

  if (dateFrom || dateTo) {
    if (dateFrom) query = query.gte('last_serviced_date', dateFrom)
    if (dateTo) query = query.lte('last_serviced_date', dateTo)
  } else if (recency) {
    if (recency.includes(':')) {
      const [fromStr, toStr] = recency.split(':')
      const fromDays = parseInt(fromStr, 10)
      const toDays = parseInt(toStr, 10)
      if (!isNaN(fromDays) && !isNaN(toDays)) {
        const computedFrom = new Date(Date.now() - toDays * 86_400_000).toISOString().slice(0, 10)
        const computedTo = new Date(Date.now() - fromDays * 86_400_000).toISOString().slice(0, 10)
        query = query.gte('last_serviced_date', computedFrom).lte('last_serviced_date', computedTo)
      }
    } else {
      const days = parseInt(recency, 10)
      if (!isNaN(days)) {
        const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
        query = query.gte('last_serviced_date', cutoff)
      }
    }
  }

  if (categoryCustomerIds) {
    query = query.in('id', categoryCustomerIds)
  }

  const { data: customers, error } = await query.limit(500)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const customerIds = (customers ?? []).map((c: { id: string }) => c.id)
  if (customerIds.length === 0) return NextResponse.json({ contacts: [] })

  // ── Contact & location enrichment ────────────────────────────────────────
  const [{ data: contactsData }, { data: locationsData }] = await Promise.all([
    db
      .from('sf_customer_contacts')
      .select('customer_id, first_name, last_name, is_primary, sf_contact_emails(email, is_primary), sf_contact_phones(phone, is_primary)')
      .in('customer_id', customerIds),
    db
      .from('sf_customer_locations')
      .select('customer_id, city, postal_code, is_primary')
      .in('customer_id', customerIds),
  ])

  // Build per-customer maps: prefer primary contact/location, fall back to first
  type RawContact = {
    customer_id: string
    first_name: string | null
    last_name: string | null
    is_primary: boolean
    sf_contact_emails: { email: string | null; is_primary: boolean }[]
    sf_contact_phones: { phone: string | null; is_primary: boolean }[]
  }
  type RawLocation = { customer_id: string; city: string | null; postal_code: string | null; is_primary: boolean }

  const contactMap = new Map<string, { first_name: string | null; last_name: string | null; email: string | null; phone: string | null }>()
  for (const c of (contactsData ?? []) as RawContact[]) {
    const existing = contactMap.get(c.customer_id)
    if (existing && !c.is_primary) continue
    const email = c.sf_contact_emails?.find(e => e.is_primary)?.email ?? c.sf_contact_emails?.[0]?.email ?? null
    const phone = c.sf_contact_phones?.find(p => p.is_primary)?.phone ?? c.sf_contact_phones?.[0]?.phone ?? null
    contactMap.set(c.customer_id, { first_name: c.first_name ?? null, last_name: c.last_name ?? null, email, phone })
  }

  const locationMap = new Map<string, { city: string | null; postal_code: string | null }>()
  for (const l of (locationsData ?? []) as RawLocation[]) {
    const existing = locationMap.get(l.customer_id)
    if (existing && !l.is_primary) continue
    locationMap.set(l.customer_id, { city: l.city ?? null, postal_code: l.postal_code ?? null })
  }

  // ── Assemble contact rows ────────────────────────────────────────────────
  type RawCustomer = { id: string; customer_name: string | null; referral_source: string | null; last_serviced_date: string | null; account_balance: number | null }
  const contacts: ContactRow[] = []

  for (const c of (customers ?? []) as RawCustomer[]) {
    const contact = contactMap.get(c.id)
    const location = locationMap.get(c.id)
    // Only include customers with an email — Mailchimp requires it
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
      last_serviced_date: c.last_serviced_date ?? null,
      account_balance: c.account_balance ?? null,
    })
  }

  return NextResponse.json({ contacts })
}
