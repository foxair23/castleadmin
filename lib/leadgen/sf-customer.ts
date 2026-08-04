import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { sfPost } from '@/lib/crm/service-fusion'
import { findExistingSfCustomer, updateExistingCustomerContactInfo, type LeadContactInfo } from '@/lib/scheduler/sf-customer-match'
import { loadLeadGenSettings } from './engine'

// LeadGen → Service Fusion customer pre-creation.
//
// When an SFI lead ages past the 1-hour mark (landing on the Action Items "SFI
// Leads" list) without being booked, create an SF CUSTOMER — never a job — so CS
// has a profile to build the job from. Returning callers are matched to their
// existing SF customer (no duplicate) and have any missing contact info appended.

const ONE_HOUR_MS = 3_600_000
// Only leads a human would actually work: exclude 'held' (awaiting review /
// possible spam), 'no_contact' (nothing to build a record from), and terminal
// states (not_interested / booked / duplicate).
const ELIGIBLE_STATUSES = ['new', 'contacted', 'callback']

function db(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

export interface LeadForCustomer {
  id: string
  customer_name: string | null
  greeting_name: string | null
  phone_e164: string | null
  phone_raw: string | null
  email: string | null
  address_street: string | null
  address_city: string | null
  address_state: string | null
  address_postal: string | null
}

/** Split a lead's name into first/last for SF (prefers the parsed greeting name). */
export function splitName(lead: LeadForCustomer): { first: string; last: string } {
  const full = (lead.customer_name ?? '').trim()
  const tokens = full.split(/\s+/).filter(Boolean)
  const first = (lead.greeting_name ?? '').trim() || tokens[0] || 'Customer'
  // Last = the full name minus the first token, else '.' (SF requires a last name).
  const last = tokens.length > 1 ? tokens.slice(1).join(' ') : '.'
  return { first, last }
}

function leadPhone(lead: LeadForCustomer): string | null {
  return lead.phone_e164 || lead.phone_raw || null
}

function toLeadContactInfo(lead: LeadForCustomer): LeadContactInfo {
  const { first, last } = splitName(lead)
  return {
    customer_first_name: first,
    customer_last_name: last,
    customer_phone: leadPhone(lead) ?? '',
    customer_email: lead.email ?? '',
    address_line1: lead.address_street ?? '',
    address_line2: null,
    address_city: lead.address_city ?? '',
    address_state: lead.address_state ?? '',
    address_zip: lead.address_postal ?? '',
  }
}

export type EnsureResult = 'created' | 'linked' | 'skipped' | 'failed'

/**
 * Ensure an SF customer exists for one lead. Matches an existing SF customer
 * first (link + append missing contact info); otherwise creates a new customer
 * (no job). Records the outcome on the lead. Idempotent — a lead already carrying
 * an sf_customer_id is skipped by the caller.
 */
export async function ensureLeadCustomer(supabase: SupabaseClient, lead: LeadForCustomer): Promise<EnsureResult> {
  const name = (lead.customer_name ?? lead.greeting_name ?? '').trim()
  const phone = leadPhone(lead)
  const hasContact = !!(phone || lead.email || lead.address_street)
  // Need a name and at least one way to identify the customer.
  if (!name || !hasContact) return 'skipped'

  // 1. Dedupe against known SF customers (returning callers).
  const existing = await findExistingSfCustomer(supabase, lead.email, phone)
  if (existing) {
    // Append any contact detail the SF profile is missing (append-only, safe).
    await updateExistingCustomerContactInfo(existing, toLeadContactInfo(lead)).catch(() => {})
    await supabase.from('leads').update({
      sf_customer_id: existing, sf_customer_source: 'linked',
      sf_customer_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('id', lead.id)
    return 'linked'
  }

  // 2. No match — create a customer, never a job.
  const { first, last } = splitName(lead)
  const payload = {
    customer_name: name,
    contacts: [{
      fname: first, lname: last || '.', is_primary: 1,
      ...(phone ? { phones: [{ phone, type: 'Mobile' }] } : {}),
      ...(lead.email ? { emails: [{ email: lead.email }] } : {}),
    }],
    ...(lead.address_street ? {
      locations: [{
        street_1: lead.address_street,
        city: lead.address_city ?? '',
        state_prov: lead.address_state ?? '',
        postal_code: lead.address_postal ?? '',
      }],
    } : {}),
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = (await sfPost('/customers', payload)) as any
    const id = String(resp?.id ?? resp?.customer?.id ?? '')
    if (!id || id === 'undefined') return 'failed'
    await supabase.from('leads').update({
      sf_customer_id: id, sf_customer_source: 'created',
      sf_customer_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('id', lead.id)
    return 'created'
  } catch (e) {
    console.error('[leadgen] SF customer create failed for lead', lead.id, e instanceof Error ? e.message : e)
    return 'failed'
  }
}

export interface EnsureCustomersResult { created: number; linked: number; skipped: number; failed: number }

/**
 * Batch pass (run by the leadgen-match cron): for every lead that has aged onto
 * the SFI Leads list (past 1h, or a callback) without being booked and without a
 * customer yet, ensure an SF customer exists. Gated on LeadGen being enabled.
 */
export async function ensureLeadCustomers(): Promise<EnsureCustomersResult> {
  const out: EnsureCustomersResult = { created: 0, linked: 0, skipped: 0, failed: 0 }
  const settings = await loadLeadGenSettings()
  if (!settings.enabled) return out

  const supabase = db()
  const { data } = await supabase
    .from('leads')
    .select('id, customer_name, greeting_name, phone_e164, phone_raw, email, address_street, address_city, address_state, address_postal, status, received_at')
    .in('status', ELIGIBLE_STATUSES)
    .is('matched_job_id', null)
    .is('sf_customer_id', null)
    .order('received_at', { ascending: true })
    .limit(100)

  const now = Date.now()
  const leads = (data ?? []).filter(l =>
    l.status === 'callback' || now - new Date(l.received_at as string).getTime() >= ONE_HOUR_MS
  ) as Array<LeadForCustomer & { status: string; received_at: string }>

  for (const lead of leads) {
    const r = await ensureLeadCustomer(supabase, lead)
    out[r] += 1
  }
  return out
}
