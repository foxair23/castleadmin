import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import LeadGenClient, { type LeadView, type InboundEvent } from '@/app/admin/leadgen/LeadGenClient'

export const dynamic = 'force-dynamic'

// Sales-facing LeadGen. Same view as /admin/leadgen (the /admin tree is
// admin-only via its layout, so sales gets its own route). Sales can work leads
// but not configure the service: the auto-send toggle and the outreach reply-to
// inbox are admin-only (view-only for sales), gated by canConfigure.
// "Handled" (acknowledged_at) — dealt with manually and marked Done on the Action
// Items "SFI Leads" list — drops a lead off Needs Action here too, matching /admin.
const HOUR_MS = 3600 * 1000
function needsAction(status: string, receivedAt: string, acknowledgedAt: string | null): boolean {
  if (acknowledgedAt) return false
  if (['booked', 'not_interested', 'duplicate'].includes(status)) return false
  if (status === 'callback') return true
  return Date.now() - new Date(receivedAt).getTime() >= HOUR_MS
}

export default async function SalesLeadGenPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (!['admin', 'sales'].includes(profile?.role ?? '')) redirect('/sales')

  const db = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

  const [{ data: settings }, { data: leadRows }, { data: inboundRows }] = await Promise.all([
    db.from('leadgen_settings').select('enabled, reply_to_email').eq('id', 1).maybeSingle(),
    db.from('leads').select('*').order('received_at', { ascending: false }).limit(500),
    db.from('leadgen_inbound_events').select('id, received_at, from_addr, subject, outcome, detail').order('received_at', { ascending: false }).limit(25),
  ])

  const rows = leadRows ?? []
  const jobIds = [...new Set(rows.map(r => r.matched_job_id).filter(Boolean))] as string[]
  const jobNumbers = new Map<string, string>()
  if (jobIds.length) {
    const { data: jobs } = await db.from('sf_jobs').select('id, number').in('id', jobIds)
    for (const j of jobs ?? []) jobNumbers.set(j.id as string, (j.number as string) ?? '')
  }

  const leads: LeadView[] = rows.map(r => ({
    id: r.id,
    provider: r.provider,
    customerName: r.customer_name,
    phone: r.phone_e164 ?? r.phone_raw,
    email: r.email,
    address: [r.address_street, r.address_city && `${r.address_city}, ${r.address_state ?? ''} ${r.address_postal ?? ''}`.trim()].filter(Boolean).join(' · ') || null,
    program: r.program_name,
    source: r.source,
    externalId: r.external_id,
    referralStore: r.referral_store,
    leadNotes: r.lead_notes,
    rawEmail: r.raw_email,
    receivedAt: r.received_at,
    status: r.status,
    heldReason: r.held_reason,
    emailSent: !!r.email_sent_at,
    smsSent: !!r.sms_sent_at,
    smsStatus: r.sms_status,
    replyText: r.reply_text,
    jobNumber: r.matched_job_id ? (jobNumbers.get(r.matched_job_id) || r.matched_job_id) : null,
    convertedAt: r.converted_at,
    needsAction: needsAction(r.status, r.received_at, r.acknowledged_at ?? null),
    acknowledgedAt: r.acknowledged_at ?? null,
    sfCustomerId: r.sf_customer_id ?? null,
  }))

  const inbound: InboundEvent[] = (inboundRows ?? []).map(r => ({
    id: r.id as string,
    receivedAt: r.received_at as string,
    from: (r.from_addr as string) ?? null,
    subject: (r.subject as string) ?? null,
    outcome: r.outcome as string,
    detail: (r.detail as string) ?? null,
  }))

  return (
    <LeadGenClient
      leads={leads}
      enabled={settings?.enabled ?? false}
      replyTo={settings?.reply_to_email ?? ''}
      inbound={inbound}
      canConfigure={profile?.role === 'admin'}
    />
  )
}
