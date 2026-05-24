import { createClient as createServiceClient } from '@supabase/supabase-js'
import { sfPost, sfGet } from '@/lib/crm/service-fusion'

function db() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

interface Lead {
  id: string
  service_type: string
  service_category: string
  diagnostic_answers: Record<string, unknown>
  customer_first_name: string
  customer_last_name: string
  customer_phone: string
  customer_email: string
  address_line1: string
  address_line2: string | null
  address_city: string
  address_state: string
  address_zip: string
  appointment_date: string
  appointment_window_start: string
  appointment_window_end: string
  description: string | null
  notes_internal: string
  lead_source: string
  incentive_applied: string | null
  sync_attempts: unknown[]
}

function sfDateTime(date: string, time: string): string {
  return `${date} ${time}:00`
}

export async function syncLeadToServiceFusion(leadId: string): Promise<void> {
  const supabase = db()

  // Fetch lead + current sync_attempts before marking in_progress
  const { data: lead, error: fetchErr } = await supabase
    .from('scheduler_leads')
    .select('*')
    .eq('id', leadId)
    .single()

  if (fetchErr || !lead) throw new Error('Lead not found')

  const l = lead as Lead
  const prevAttempts = Array.isArray(l.sync_attempts) ? l.sync_attempts : []
  const attemptAt = new Date().toISOString()

  await supabase
    .from('scheduler_leads')
    .update({ sync_status: 'in_progress' })
    .eq('id', leadId)

  let sfCustomerId: string | null = null
  let sfJobId: string | null = null

  try {
    // ── 0. Fetch a valid job status ID ──────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const statusesResp = (await sfGet('/job-statuses', { 'per-page': '50' })) as any
    const statuses: { id: number; name: string }[] = statusesResp?.items ?? []
    const openStatus = statuses.find(s =>
      /pending|open|new|schedul/i.test(s.name)
    ) ?? statuses[0]
    if (!openStatus) throw new Error('No job statuses found in Service Fusion account')
    const sfStatusId: number = openStatus.id
    const sfStatusName: string = openStatus.name
    // ── 1. Create customer ──────────────────────────────────────────────────
    const customerPayload = {
      customer_name: l.customer_last_name
        ? `${l.customer_first_name} ${l.customer_last_name}`
        : l.customer_first_name,
      contacts: [
        {
          fname: l.customer_first_name,
          lname: l.customer_last_name || '.',
          is_primary: 1,
          phones: [{ phone: l.customer_phone, type: 'Mobile' }],
          ...(l.customer_email ? { emails: [{ email: l.customer_email }] } : {}),
        },
      ],
      locations: [
        {
          street_1: l.address_line1,
          ...(l.address_line2 ? { street_2: l.address_line2 } : {}),
          city: l.address_city,
          state_prov: l.address_state,
          postal_code: l.address_zip,
        },
      ],
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const customerResp = (await sfPost('/customers', customerPayload)) as any
    sfCustomerId = String(customerResp?.id ?? customerResp?.customer?.id ?? '')
    if (!sfCustomerId || sfCustomerId === 'undefined') {
      throw new Error('No customer ID returned from Service Fusion')
    }

    // ── 2. Build description ───────────────────────────────────────────────
    const diag = l.diagnostic_answers as { issues?: string[]; opener?: string; door_type?: string }
    const descLines: string[] = []
    if (l.description) descLines.push(l.description)
    if (diag.issues?.length) descLines.push(`Issues: ${diag.issues.join(', ')}`)
    if (diag.opener) descLines.push(`Opener: ${diag.opener}`)
    if (diag.door_type) descLines.push(`Door type: ${diag.door_type}`)
    if (l.incentive_applied) descLines.push(`Incentive: ${l.incentive_applied}`)
    descLines.push(`Booking ID: ${l.id}`)

    // ── 3. Create job ───────────────────────────────────────────────────────
    const jobPayload = {
      customer_name: parseInt(sfCustomerId, 10),
      contact_first_name: l.customer_first_name,
      contact_last_name: l.customer_last_name || '.',
      street_1: l.address_line1,
      ...(l.address_line2 ? { street_2: l.address_line2 } : {}),
      city: l.address_city,
      state_prov: l.address_state,
      postal_code: l.address_zip,
      status: sfStatusName || sfStatusId,
      source: l.lead_source,
      description: descLines.join('\n'),
      start_date: l.appointment_date,
      time_frame_promised_start: l.appointment_window_start,
      time_frame_promised_end: l.appointment_window_end,
      ...(l.notes_internal ? { notes: l.notes_internal } : {}),
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jobResp = (await sfPost('/jobs', jobPayload)) as any
    sfJobId = String(jobResp?.id ?? jobResp?.job?.id ?? '')
    if (!sfJobId || sfJobId === 'undefined') {
      throw new Error('No job ID returned from Service Fusion')
    }

    // ── 4. Mark synced ──────────────────────────────────────────────────────
    await supabase
      .from('scheduler_leads')
      .update({
        sync_status: 'synced',
        service_fusion_customer_id: sfCustomerId,
        service_fusion_job_id: sfJobId,
        synced_at: new Date().toISOString(),
        sync_attempts: [
          ...prevAttempts,
          { at: attemptAt, ok: true, sf_customer_id: sfCustomerId, sf_job_id: sfJobId },
        ],
      })
      .eq('id', leadId)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[sf-sync] Lead ${leadId} sync failed:`, message)

    await supabase
      .from('scheduler_leads')
      .update({
        sync_status: 'sync_failed',
        ...(sfCustomerId ? { service_fusion_customer_id: sfCustomerId } : {}),
        sync_attempts: [
          ...prevAttempts,
          {
            at: attemptAt,
            ok: false,
            error: message,
            ...(sfCustomerId ? { sf_customer_id: sfCustomerId } : {}),
          },
        ],
      })
      .eq('id', leadId)

    throw err
  }
}
