// Resolve a job's customer contact (best email + phone) from the SF mirror.
//
// Email/phone are NOT on sf_jobs — they live in the normalized contact tree:
//   sf_jobs.customer_id → sf_customers → sf_customer_contacts
//     → sf_contact_emails / sf_contact_phones   (prefer is_primary)
// This is the forward direction of find_sf_customer_by_contact (migration 046),
// and reuses the same nested-select join the sales lead detail page uses.
//
// Caveat: the contact tables only refresh on backfill/weekly reconcile (not the
// hourly incremental sync), so a recently-changed customer may have a stale or
// missing address here — which is exactly why the send UI lets the operator
// confirm/override the resolved email + phone before sending.

import type { SupabaseClient } from '@supabase/supabase-js'
import { toLineItems, type ApprovalLineItem } from './acceptance'

export interface JobApprovalContext {
  jobId: string
  jobNumber: string | null
  customerName: string | null
  contactName: string | null
  jobDescription: string | null
  email: string | null
  phone: string | null
  lineItems: ApprovalLineItem[]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pickPrimary(rows: any[] | null | undefined, get: (r: any) => string | null): string | null {
  const list = rows ?? []
  const primary = list.find(r => r.is_primary && get(r))
  if (primary) return get(primary)
  const first = list.find(r => get(r))
  return first ? get(first) : null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadJobApprovalContext(db: SupabaseClient<any>, jobId: string): Promise<JobApprovalContext | null> {
  const { data: job } = await db
    .from('sf_jobs')
    .select('id, number, customer_id, customer_name, contact_first_name, contact_last_name, description')
    .eq('id', jobId)
    .maybeSingle()
  if (!job) return null

  const { data: items } = await db
    .from('sf_job_items')
    .select('name, description, quantity, unit_price, total')
    .eq('sf_job_id', jobId)

  let email: string | null = null
  let phone: string | null = null
  if (job.customer_id) {
    const { data: contacts } = await db
      .from('sf_customer_contacts')
      .select('is_primary, sf_contact_emails(email, is_primary), sf_contact_phones(phone, is_primary)')
      .eq('customer_id', job.customer_id)

    // Prefer emails/phones on the primary contact, then any contact.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sorted = [...((contacts ?? []) as any[])].sort((a, b) => Number(!!b.is_primary) - Number(!!a.is_primary))
    for (const c of sorted) {
      if (!email) email = pickPrimary(c.sf_contact_emails, (e: { email: string | null }) => e.email)
      if (!phone) phone = pickPrimary(c.sf_contact_phones, (p: { phone: string | null }) => p.phone)
      if (email && phone) break
    }
  }

  const contactName = [job.contact_first_name, job.contact_last_name].filter(Boolean).join(' ').trim() || null

  return {
    jobId: job.id,
    jobNumber: job.number ?? null,
    customerName: job.customer_name ?? null,
    contactName,
    jobDescription: (job.description as string | null) ?? null,
    email,
    phone,
    lineItems: toLineItems(items ?? []),
  }
}
