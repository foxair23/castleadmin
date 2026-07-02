/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SupabaseClient } from '@supabase/supabase-js'
import { sfGet, sfPut } from '@/lib/crm/service-fusion'

const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '')
const last10 = (s: string | null | undefined) => {
  const d = digits(s)
  return d.length >= 10 ? d.slice(-10) : d
}

// Find an existing SF customer by contact email/phone via the local mirror.
// Returns the best matching customer id (email preferred, most recently
// serviced), or null. Never throws — a lookup failure just means "no match".
export async function findExistingSfCustomer(
  db: SupabaseClient,
  email: string | null | undefined,
  phone: string | null | undefined,
): Promise<string | null> {
  try {
    const { data, error } = await db.rpc('find_sf_customer_by_contact', {
      p_email: email ?? '',
      p_phone: phone ?? '',
    })
    if (error) {
      console.error('[sf-match] rpc error:', error.message)
      return null
    }
    return typeof data === 'string' && data ? data : null
  } catch (e) {
    console.error('[sf-match] lookup failed:', e instanceof Error ? e.message : e)
    return null
  }
}

export interface LeadContactInfo {
  customer_first_name: string
  customer_last_name: string
  customer_phone: string
  customer_email: string
  address_line1: string
  address_line2: string | null
  address_city: string
  address_state: string
  address_zip: string
}

// Best-effort: add the booking's email / phone / address to an existing SF
// customer when those values are missing. Reads the current customer (GET),
// APPENDS only (never removes), and writes back (PUT). If the response can't be
// parsed into the expected shape, it skips the write entirely so a partial
// payload can never clobber the record. The caller must wrap this in try/catch
// so a failure can't break the sync (the job still attaches to the customer).
export async function updateExistingCustomerContactInfo(
  sfCustomerId: string,
  lead: LeadContactInfo,
): Promise<{ updated: boolean }> {
  const raw = (await sfGet(`/customers/${sfCustomerId}`, {
    expand: 'contacts,contacts.phones,contacts.emails,locations',
  })) as any
  const cust = raw?.customer ?? raw
  const contactsIn: any[] = Array.isArray(cust?.contacts) ? cust.contacts : []
  const locationsIn: any[] = Array.isArray(cust?.locations) ? cust.locations : []
  // Unexpected shape — do not risk a destructive write.
  if (contactsIn.length === 0) return { updated: false }

  let changed = false

  // Rebuild contacts using the same field vocabulary we use on create, so the
  // PUT is accepted; preserve ids so existing contacts aren't duplicated.
  const contacts = contactsIn.map(c => {
    const emails = (Array.isArray(c.emails) ? c.emails : [])
      .map((e: any) => ({ email: e.email }))
      .filter((e: any) => e.email)
    const phones = (Array.isArray(c.phones) ? c.phones : [])
      .map((p: any) => ({ phone: p.phone, ...(p.type ? { type: p.type } : {}) }))
      .filter((p: any) => p.phone)
    return {
      ...(c.id ? { id: c.id } : {}),
      fname: c.fname ?? c.first_name ?? '',
      lname: c.lname ?? c.last_name ?? '.',
      is_primary: c.is_primary ? 1 : 0,
      emails,
      phones,
      _emailSet: new Set(emails.map((e: any) => String(e.email).toLowerCase())),
      _phoneSet: new Set(phones.map((p: any) => last10(p.phone))),
    }
  })

  const target = contacts.find(c => c.is_primary) ?? contacts[0]

  const leadEmail = (lead.customer_email ?? '').trim()
  if (leadEmail && !target._emailSet.has(leadEmail.toLowerCase())) {
    target.emails.push({ email: leadEmail })
    changed = true
  }
  const leadPhone10 = last10(lead.customer_phone)
  if (leadPhone10.length === 10 && !target._phoneSet.has(leadPhone10)) {
    target.phones.push({ phone: lead.customer_phone, type: 'Mobile' })
    changed = true
  }

  // Locations — append the booking address if not already present (street + zip).
  const locKey = (street: string, zip: string) => `${(street ?? '').trim().toLowerCase()}|${digits(zip)}`
  const existingLocKeys = new Set(locationsIn.map(loc => locKey(loc.street_1 ?? '', loc.postal_code ?? '')))
  const locations = locationsIn.map(loc => ({
    ...(loc.id ? { id: loc.id } : {}),
    street_1: loc.street_1 ?? '',
    ...(loc.street_2 ? { street_2: loc.street_2 } : {}),
    city: loc.city ?? '',
    state_prov: loc.state_prov ?? '',
    postal_code: loc.postal_code ?? '',
  }))
  if (lead.address_line1 && !existingLocKeys.has(locKey(lead.address_line1, lead.address_zip))) {
    locations.push({
      street_1: lead.address_line1,
      ...(lead.address_line2 ? { street_2: lead.address_line2 } : {}),
      city: lead.address_city,
      state_prov: lead.address_state,
      postal_code: lead.address_zip,
    })
    changed = true
  }

  if (!changed) return { updated: false }

  // Drop the internal lookup sets before sending.
  const contactsOut = contacts.map(({ _emailSet, _phoneSet, ...c }) => c)
  await sfPut(`/customers/${sfCustomerId}`, {
    customer_name: cust.customer_name,
    contacts: contactsOut,
    locations,
  })
  return { updated: true }
}
