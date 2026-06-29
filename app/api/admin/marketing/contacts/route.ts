import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { filtersFromParams, getMatchingCustomerIds } from '@/lib/marketing/query'

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return null
  return user
}

// Fetch every matching row past PostgREST's 1000-row response cap.
async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null }>
): Promise<T[]> {
  const PAGE = 1000
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data } = await build(from, from + PAGE - 1)
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
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

const DEFAULT_PAGE_SIZE = 250
const MAX_PAGE_SIZE = 1000

export async function GET(req: NextRequest) {
  const admin = await requireAdmin()
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const filters = filtersFromParams(searchParams)
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1)
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(searchParams.get('page_size') ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE))

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // All matching ids (ordered by last service date), then slice to the page.
  const allIds = await getMatchingCustomerIds(db, filters)
  const total = allIds.length
  const pageIds = allIds.slice((page - 1) * pageSize, page * pageSize)
  if (pageIds.length === 0) {
    return NextResponse.json({ contacts: [], total, page, pageSize })
  }

  // Customer display fields for the page, in page order.
  type RawCustomer = { id: string; customer_name: string | null; referral_source: string | null; last_serviced_date: string | null; account_balance: number | null }
  const { data: custRows } = await db
    .from('sf_customers')
    .select('id, customer_name, referral_source, last_serviced_date, account_balance')
    .in('id', pageIds)
  const custById = new Map<string, RawCustomer>((custRows ?? []).map((c: RawCustomer) => [c.id, c]))

  // ── Enrich the page with contacts, locations, last service date ──────────
  type RawContact = { id: string; customer_id: string; first_name: string | null; last_name: string | null; is_primary: boolean }
  type RawLocation = { customer_id: string; city: string | null; postal_code: string | null; is_primary: boolean }
  type RawEmail = { contact_id: string; email: string | null; is_primary: boolean }
  type RawPhone = { contact_id: string; phone: string | null; is_primary: boolean }

  const [contactsData, locationsData, jobDates] = await Promise.all([
    fetchAll<RawContact>((from, to) =>
      db.from('sf_customer_contacts').select('id, customer_id, first_name, last_name, is_primary')
        .in('customer_id', pageIds).order('id', { ascending: true }).range(from, to)),
    fetchAll<RawLocation>((from, to) =>
      db.from('sf_customer_locations').select('customer_id, city, postal_code, is_primary')
        .in('customer_id', pageIds).order('customer_id', { ascending: true }).range(from, to)),
    fetchAll<{ customer_id: string; closed_at: string }>((from, to) =>
      db.from('sf_jobs').select('customer_id, closed_at').in('customer_id', pageIds)
        .eq('is_deleted', false).not('closed_at', 'is', null)
        .order('closed_at', { ascending: false }).range(from, to)),
  ])

  const contactIds = contactsData.map(c => c.id)
  const [emailsData, phonesData] = await Promise.all([
    contactIds.length > 0
      ? fetchAll<RawEmail>((from, to) =>
          db.from('sf_contact_emails').select('contact_id, email, is_primary')
            .in('contact_id', contactIds).order('contact_id', { ascending: true }).range(from, to))
      : Promise.resolve([] as RawEmail[]),
    contactIds.length > 0
      ? fetchAll<RawPhone>((from, to) =>
          db.from('sf_contact_phones').select('contact_id, phone, is_primary')
            .in('contact_id', contactIds).order('contact_id', { ascending: true }).range(from, to))
      : Promise.resolve([] as RawPhone[]),
  ])

  const emailsByContact = new Map<string, RawEmail[]>()
  for (const e of emailsData) {
    const arr = emailsByContact.get(e.contact_id) ?? []; arr.push(e); emailsByContact.set(e.contact_id, arr)
  }
  const phonesByContact = new Map<string, RawPhone[]>()
  for (const p of phonesData) {
    const arr = phonesByContact.get(p.contact_id) ?? []; arr.push(p); phonesByContact.set(p.contact_id, arr)
  }

  const contactMap = new Map<string, { first_name: string | null; last_name: string | null; email: string | null; phone: string | null }>()
  for (const c of contactsData) {
    const existing = contactMap.get(c.customer_id)
    if (existing && !c.is_primary) continue
    const emails = emailsByContact.get(c.id) ?? []
    const phones = phonesByContact.get(c.id) ?? []
    const email = emails.find(e => e.is_primary)?.email ?? emails[0]?.email ?? null
    const phone = phones.find(p => p.is_primary)?.phone ?? phones[0]?.phone ?? null
    contactMap.set(c.customer_id, { first_name: c.first_name ?? null, last_name: c.last_name ?? null, email, phone })
  }

  const locationMap = new Map<string, { city: string | null; postal_code: string | null }>()
  for (const l of locationsData) {
    const existing = locationMap.get(l.customer_id)
    if (existing && !l.is_primary) continue
    locationMap.set(l.customer_id, { city: l.city ?? null, postal_code: l.postal_code ?? null })
  }

  const lastServiceMap = new Map<string, string>()
  for (const j of jobDates) {
    if (!lastServiceMap.has(j.customer_id)) lastServiceMap.set(j.customer_id, j.closed_at.slice(0, 10))
  }

  // Build rows in page (last-service-date) order.
  const contacts: ContactRow[] = []
  for (const id of pageIds) {
    const c = custById.get(id)
    if (!c) continue
    const contact = contactMap.get(id)
    const location = locationMap.get(id)
    contacts.push({
      customer_id: id,
      customer_name: c.customer_name ?? null,
      email: contact?.email ?? null,
      first_name: contact?.first_name ?? null,
      last_name: contact?.last_name ?? null,
      phone: contact?.phone ?? null,
      city: location?.city ?? null,
      postal_code: location?.postal_code ?? null,
      lead_source: c.referral_source ?? null,
      last_serviced_date: lastServiceMap.get(id) ?? c.last_serviced_date ?? null,
      account_balance: c.account_balance ?? null,
    })
  }

  return NextResponse.json({ contacts, total, page, pageSize })
}
