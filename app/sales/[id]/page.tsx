import { redirect, notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import LeadDetailClient from './LeadDetailClient'

export const dynamic = 'force-dynamic'

function adminDb() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

export default async function SalesLeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, is_active, full_name')
    .eq('id', user.id)
    .single()

  if (!profile?.is_active || !['admin', 'sales'].includes(profile.role ?? '')) {
    redirect('/login')
  }

  const isAdmin = profile.role === 'admin'
  const db = adminDb()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: lead } = await (db as any)
    .from('sales_leads')
    .select('*')
    .eq('id', id)
    .single()

  if (!lead) notFound()

  // Sales users can only see their own leads
  if (!isAdmin && lead.assigned_to_user_id !== user.id) redirect('/sales')

  const customerId: string = lead.customer_id
  const campaignId: string = lead.mailchimp_campaign_id

  // All secondary data in parallel
  const [
    customerRes,
    locationsRes,
    contactsRes,
    equipmentRes,
    jobsRes,
    campaignRes,
    callsRes,
    notesRes,
    historyRes,
    statusesRes,
    dispositionsRes,
    assigneeRes,
    lifetimeSpendRes,
  ] = await Promise.all([
    db.from('sf_customers').select('*').eq('id', customerId).single(),
    db.from('sf_customer_locations').select('*').eq('customer_id', customerId).eq('is_deleted', false),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any)
      .from('sf_customer_contacts')
      .select('id, first_name, last_name, is_primary, sf_contact_emails(email, is_primary), sf_contact_phones(phone, type, is_primary)')
      .eq('customer_id', customerId),
    db.from('sf_customer_equipment').select('*').eq('customer_id', customerId).eq('is_deleted', false),
    db
      .from('sf_jobs')
      .select('id, number, start_date, category, total, status_name, is_deleted')
      .eq('customer_id', customerId)
      .eq('is_deleted', false)
      .order('start_date', { ascending: false })
      .limit(20),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).from('mc_campaigns').select('mailchimp_campaign_id, subject, tag_name, send_time').eq('mailchimp_campaign_id', campaignId).single(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any)
      .from('sales_calls')
      .select('id, user_id, called_at, disposition, duration_minutes, notes')
      .eq('lead_id', id)
      .order('called_at', { ascending: false }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any)
      .from('sales_notes')
      .select('id, user_id, body, created_at')
      .eq('lead_id', id)
      .order('created_at', { ascending: false }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any)
      .from('sales_status_history')
      .select('id, user_id, from_status, to_status, changed_at')
      .eq('lead_id', id)
      .order('changed_at', { ascending: false }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).from('sales_pipeline_statuses').select('id, name, sort_order').eq('is_active', true).order('sort_order'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).from('sales_call_dispositions').select('id, name, sort_order').eq('is_active', true).order('sort_order'),
    lead.assigned_to_user_id
      ? db.from('profiles').select('full_name').eq('id', lead.assigned_to_user_id).single()
      : Promise.resolve({ data: null }),
    // Lifetime spend: sum of job totals
    db
      .from('sf_jobs')
      .select('total')
      .eq('customer_id', customerId)
      .eq('is_deleted', false),
  ])

  // Resolve rep names for calls and notes
  const actorIds = [
    ...new Set([
      ...(callsRes.data ?? []).map((c: any) => c.user_id),
      ...(notesRes.data ?? []).map((n: any) => n.user_id),
      ...(historyRes.data ?? []).map((h: any) => h.user_id).filter(Boolean),
    ]),
  ]

  const { data: actors } = actorIds.length
    ? await db.from('profiles').select('id, full_name').in('id', actorIds)
    : { data: [] }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actorMap = new Map((actors ?? []).map((a: any) => [a.id, a.full_name as string]))

  const lifetimeSpend = (lifetimeSpendRes.data ?? []).reduce(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sum: number, j: any) => sum + (Number(j.total) || 0),
    0
  )

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const customer = customerRes.data as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const campaign = campaignRes.data as any

  const primaryLocation = (locationsRes.data ?? []).find((l: any) => l.is_primary) ?? (locationsRes.data ?? [])[0] ?? null

  // Flatten contacts → primary phone and email
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allPhones: { phone: string; type: string | null }[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allEmails: string[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const contact of (contactsRes.data ?? []) as any[]) {
    for (const p of contact.sf_contact_phones ?? []) {
      if (p.phone) allPhones.push({ phone: p.phone, type: p.type })
    }
    for (const e of contact.sf_contact_emails ?? []) {
      if (e.email && !allEmails.includes(e.email)) allEmails.push(e.email)
    }
  }

  const props = {
    lead: lead as any,
    customer,
    primaryLocation: primaryLocation as any,
    phones: allPhones,
    emails: allEmails,
    equipment: (equipmentRes.data ?? []) as any[],
    jobs: (jobsRes.data ?? []) as any[],
    campaign,
    calls: ((callsRes.data ?? []) as any[]).map(c => ({ ...c, rep_name: actorMap.get(c.user_id) ?? 'Unknown' })),
    notes: ((notesRes.data ?? []) as any[]).map(n => ({ ...n, rep_name: actorMap.get(n.user_id) ?? 'Unknown' })),
    history: ((historyRes.data ?? []) as any[]).map(h => ({ ...h, rep_name: h.user_id ? (actorMap.get(h.user_id) ?? 'Unknown') : null })),
    pipelineStatuses: (statusesRes.data ?? []) as any[],
    callDispositions: (dispositionsRes.data ?? []) as any[],
    assignedRepName: (assigneeRes.data as any)?.full_name ?? null,
    lifetimeSpend,
    isAdmin,
    currentUserId: user.id,
  }

  return <LeadDetailClient {...props} />
}
