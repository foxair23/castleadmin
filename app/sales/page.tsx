import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import SalesLeadsClient from './SalesLeadsClient'

export const dynamic = 'force-dynamic'

export default async function SalesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, is_active')
    .eq('id', user.id)
    .single()

  if (!profile?.is_active || !['admin', 'sales'].includes(profile.role ?? '')) {
    redirect('/login')
  }

  const isAdmin = profile.role === 'admin'

  // Use service role for admin (sees all leads); anon client for sales (RLS scopes to assigned)
  const db = isAdmin
    ? createAdminClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { auth: { persistSession: false } }
      )
    : supabase

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rawLeads, error: leadsError } = await (db as any)
    .from('sales_leads')
    .select(
      'id, customer_id, mailchimp_campaign_id, tag_name, status, ' +
      'assigned_to_user_id, created_at, first_opened_at, last_opened_at, ' +
      'open_count, click_count, last_activity_at, closed_outcome, sf_job_created'
    )
    // Reps only work engaged leads — anyone who opened or clicked.
    // (Guards against stale non-engaged leads left by earlier sync logic.)
    .or('open_count.gt.0,click_count.gt.0')
    .order('last_activity_at', { ascending: false })
    .limit(500)

  if (leadsError) console.error('[sales/page] sales_leads query error:', leadsError)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const leads: any[] = rawLeads ?? []

  // Batch-resolve customer names and campaign subjects
  const customerIds = [...new Set(leads.map(l => l.customer_id).filter(Boolean))]
  const campaignIds = [...new Set(leads.map(l => l.mailchimp_campaign_id).filter(Boolean))]
  const assigneeIds = [...new Set(leads.map(l => l.assigned_to_user_id).filter(Boolean))]

  const adminDb = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  const [customersRes, locationsRes, contactsRes, campaignsRes, assigneesRes, lastCallsRes] = await Promise.all([
    customerIds.length
      ? adminDb
          .from('sf_customers')
          .select('id, customer_name, account_number, last_serviced_date')
          .in('id', customerIds)
      : Promise.resolve({ data: [] }),
    customerIds.length
      ? adminDb
          .from('sf_customer_locations')
          .select('customer_id, city, state_prov, is_primary')
          .in('customer_id', customerIds)
      : Promise.resolve({ data: [] }),
    customerIds.length
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? (adminDb as any)
          .from('sf_customer_contacts')
          .select('customer_id, is_primary, sf_contact_phones(phone, type, is_primary)')
          .in('customer_id', customerIds)
      : Promise.resolve({ data: [] }),
    campaignIds.length
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? (adminDb as any)
          .from('mc_campaigns')
          .select('mailchimp_campaign_id, subject, tag_name')
          .in('mailchimp_campaign_id', campaignIds)
      : Promise.resolve({ data: [] }),
    assigneeIds.length
      ? adminDb
          .from('profiles')
          .select('id, full_name')
          .in('id', assigneeIds)
      : Promise.resolve({ data: [] }),
    // Most recent call disposition per lead
    leads.length
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? (adminDb as any)
          .from('sales_calls')
          .select('lead_id, disposition, called_at')
          .in('lead_id', leads.map((l: any) => l.id))
          .order('called_at', { ascending: false })
      : Promise.resolve({ data: [] }),
  ])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const customerMap = new Map((customersRes.data ?? []).map((c: any) => [c.id, c]))

  // Primary location per customer (primary flag preferred, else first)
  const locationMap = new Map<string, { city: string | null; state_prov: string | null }>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const loc of (locationsRes.data ?? []) as any[]) {
    if (!locationMap.has(loc.customer_id) || loc.is_primary) {
      locationMap.set(loc.customer_id, { city: loc.city, state_prov: loc.state_prov })
    }
  }

  // Primary phone per customer (first phone from primary contact, else any)
  const phoneMap = new Map<string, string>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const contact of (contactsRes.data ?? []) as any[]) {
    if (phoneMap.has(contact.customer_id) && !contact.is_primary) continue
    const phones: { phone: string; is_primary: boolean }[] = contact.sf_contact_phones ?? []
    const primary = phones.find(p => p.is_primary) ?? phones[0]
    if (primary?.phone) phoneMap.set(contact.customer_id, primary.phone)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const campaignMap = new Map((campaignsRes.data ?? []).map((c: any) => [c.mailchimp_campaign_id, c]))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const assigneeMap = new Map((assigneesRes.data ?? []).map((p: any) => [p.id, p.full_name as string]))
  // Keep only the latest call per lead
  const lastCallMap = new Map<string, string>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const call of ((lastCallsRes.data ?? []) as any[])) {
    if (!lastCallMap.has(call.lead_id)) {
      lastCallMap.set(call.lead_id, call.disposition)
    }
  }

  const enrichedLeads = leads.map(l => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const customer = customerMap.get(l.customer_id) as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const campaign = campaignMap.get(l.mailchimp_campaign_id) as any
    const daysSinceActivity = l.last_activity_at
      ? Math.floor((Date.now() - new Date(l.last_activity_at).getTime()) / 86_400_000)
      : null
    const daysSinceCreated = l.created_at
      ? Math.floor((Date.now() - new Date(l.created_at).getTime()) / 86_400_000)
      : null

    const location = locationMap.get(l.customer_id)
    return {
      id: l.id,
      customer_id: l.customer_id,
      customer_name: customer?.customer_name ?? l.customer_id,
      account_number: customer?.account_number ?? null,
      last_serviced_date: customer?.last_serviced_date ?? null,
      phone: phoneMap.get(l.customer_id) ?? null,
      customer_city: location?.city ?? null,
      customer_state: location?.state_prov ?? null,
      mailchimp_campaign_id: l.mailchimp_campaign_id,
      campaign_subject: campaign?.subject ?? null,
      tag_name: l.tag_name ?? campaign?.tag_name ?? null,
      status: l.status as string,
      assigned_to_user_id: l.assigned_to_user_id ?? null,
      assigned_rep_name: l.assigned_to_user_id ? (assigneeMap.get(l.assigned_to_user_id) ?? null) : null,
      open_count: l.open_count as number,
      click_count: l.click_count as number,
      last_opened_at: l.last_opened_at ?? null,
      last_activity_at: l.last_activity_at ?? null,
      days_since_activity: daysSinceActivity,
      days_since_created: daysSinceCreated,
      last_call_disposition: lastCallMap.get(l.id) ?? null,
      closed_outcome: l.closed_outcome ?? null,
      sf_job_created: l.sf_job_created as boolean,
    }
  })

  return <SalesLeadsClient initialLeads={enrichedLeads} isAdmin={isAdmin} />
}
