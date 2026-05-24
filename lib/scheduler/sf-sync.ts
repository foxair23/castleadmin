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
    const diag = l.diagnostic_answers as {
      can_open_close?: string
      estimated_age?: string
      replacement_type?: string
      multiple_doors?: string
      opener_need?: string
      gate_type?: string
    }

    const serviceTypeLabel = l.service_type === 'garage_door' ? 'Garage Door' : 'Gate'
    const serviceCategoryLabels: Record<string, string> = {
      repairs_service: 'Repairs & Service',
      door_panel_replacement: 'Door / Panel Replacement',
      opener_service: 'Opener Service / Replacement',
      gate_opener_service: 'Gate Opener Service / Replacement',
      new_gate_replacement: 'New Gate / Gate Replacement',
    }
    const diagLabels: Record<string, Record<string, string>> = {
      can_open_close:   { yes: 'Yes', no: 'No' },
      estimated_age:    { less_than_8_years: 'Less than 8 years', '8_years_or_older': '8 years or older', not_sure: 'Not sure' },
      replacement_type: { basic_functional: 'Basic & Functional', nicer_more_features: 'Nicer with More Features', not_sure: 'Not sure' },
      multiple_doors:   { yes: 'Yes', no: 'No' },
      opener_need:      { repair_existing: 'Repair existing', replace: 'Replace', add_opener: 'Add opener', not_sure: 'Not sure' },
      gate_type:        { swing: 'Swing Gate', sliding: 'Sliding Gate', pedestrian: 'Pedestrian Gate', not_sure: 'Not sure' },
    }

    const descLines: string[] = []
    descLines.push(`Service: ${serviceTypeLabel} — ${serviceCategoryLabels[l.service_category] ?? l.service_category}`)
    if (diag.can_open_close)   descLines.push(`Can open/close: ${diagLabels.can_open_close[diag.can_open_close] ?? diag.can_open_close}`)
    if (diag.estimated_age)    descLines.push(`Door age: ${diagLabels.estimated_age[diag.estimated_age] ?? diag.estimated_age}`)
    if (diag.replacement_type) descLines.push(`Looking for: ${diagLabels.replacement_type[diag.replacement_type] ?? diag.replacement_type}`)
    if (diag.multiple_doors)   descLines.push(`Multiple doors: ${diagLabels.multiple_doors[diag.multiple_doors] ?? diag.multiple_doors}`)
    if (diag.opener_need)      descLines.push(`Opener need: ${diagLabels.opener_need[diag.opener_need] ?? diag.opener_need}`)
    if (diag.gate_type)        descLines.push(`Gate type: ${diagLabels.gate_type[diag.gate_type] ?? diag.gate_type}`)
    if (l.description)         descLines.push(`Notes: ${l.description}`)
    if (l.incentive_applied)   descLines.push(`Incentive: ${l.incentive_applied}`)
    descLines.push(`Lead source: ${l.lead_source}`)
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
      description: descLines.join('\n'),
      start_date: l.appointment_date,
      time_frame_promised_start: l.appointment_window_start,
      time_frame_promised_end: l.appointment_window_end,
      ...(l.notes_internal ? { notes: l.notes_internal } : {}),
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jobResp = (await sfPost('/jobs', jobPayload)) as any
    console.log('[sf-sync] job response:', JSON.stringify(jobResp))
    sfJobId = String(jobResp?.id ?? jobResp?.job?.id ?? jobResp?.data?.id ?? '')
    if (!sfJobId || sfJobId === 'undefined') {
      throw new Error(`No job ID returned from Service Fusion. Response: ${JSON.stringify(jobResp)}`)
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
