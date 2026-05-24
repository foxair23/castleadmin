import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient, SupabaseClient } from '@supabase/supabase-js'
import { pushContacts } from '@/lib/mailchimp/client'
import type { MailchimpContact } from '@/lib/mailchimp/client'

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return null
  return user
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchContactsForIds(db: SupabaseClient<any>, customerIds: string[]): Promise<MailchimpContact[]> {
  if (customerIds.length === 0) return []

  const [{ data: customers }, { data: contactsData }, { data: locationsData }] = await Promise.all([
    db.from('sf_customers')
      .select('id, referral_source, last_serviced_date, account_balance')
      .in('id', customerIds)
      .eq('is_deleted', false),
    db.from('sf_customer_contacts')
      .select('customer_id, first_name, last_name, is_primary, sf_contact_emails(email, is_primary), sf_contact_phones(phone, is_primary)')
      .in('customer_id', customerIds),
    db.from('sf_customer_locations')
      .select('customer_id, city, postal_code, is_primary')
      .in('customer_id', customerIds),
  ])

  type RawContact = {
    customer_id: string; first_name: string | null; last_name: string | null; is_primary: boolean
    sf_contact_emails: { email: string | null; is_primary: boolean }[]
    sf_contact_phones: { phone: string | null; is_primary: boolean }[]
  }
  type RawLocation = { customer_id: string; city: string | null; postal_code: string | null; is_primary: boolean }

  const contactMap = new Map<string, { first_name: string | null; last_name: string | null; email: string | null; phone: string | null }>()
  for (const c of (contactsData ?? []) as RawContact[]) {
    if (contactMap.has(c.customer_id) && !c.is_primary) continue
    const email = c.sf_contact_emails?.find(e => e.is_primary)?.email ?? c.sf_contact_emails?.[0]?.email ?? null
    const phone = c.sf_contact_phones?.find(p => p.is_primary)?.phone ?? c.sf_contact_phones?.[0]?.phone ?? null
    contactMap.set(c.customer_id, { first_name: c.first_name ?? null, last_name: c.last_name ?? null, email, phone })
  }

  const locationMap = new Map<string, { city: string | null; postal_code: string | null }>()
  for (const l of (locationsData ?? []) as RawLocation[]) {
    if (locationMap.has(l.customer_id) && !l.is_primary) continue
    locationMap.set(l.customer_id, { city: l.city ?? null, postal_code: l.postal_code ?? null })
  }

  type RawCustomer = { id: string; referral_source: string | null; last_serviced_date: string | null; account_balance: number | null }
  const contacts: MailchimpContact[] = []

  for (const c of (customers ?? []) as RawCustomer[]) {
    const contact = contactMap.get(c.id)
    if (!contact?.email) continue  // Mailchimp requires an email
    const location = locationMap.get(c.id)
    contacts.push({
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

  return contacts
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin()
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { customerIds, tag } = body as { customerIds: string[]; tag: string }

  if (!tag?.trim()) return NextResponse.json({ error: 'Tag is required' }, { status: 400 })
  if (!Array.isArray(customerIds) || customerIds.length === 0) {
    return NextResponse.json({ error: 'customerIds must be a non-empty array' }, { status: 400 })
  }

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const contacts = await fetchContactsForIds(db, customerIds)
  const result = await pushContacts(contacts, tag.trim())

  await db.from('mailchimp_push_log').insert({
    pushed_at: new Date().toISOString(),
    tag: tag.trim(),
    filter_criteria: { customer_ids_count: customerIds.length },
    contact_count: contacts.length,
    added_count: result.added,
    updated_count: result.updated,
    skipped_count: result.skipped,
    failed_count: result.errored,
    contact_results: result.errors,
    created_by: admin.id,
  })

  return NextResponse.json(result)
}
