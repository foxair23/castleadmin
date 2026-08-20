import { createClient as createServiceClient, type SupabaseClient } from '@supabase/supabase-js'
import { sfPost } from '@/lib/crm/service-fusion'
import { findExistingSfCustomer, updateExistingCustomerContactInfo } from '@/lib/scheduler/sf-customer-match'
import { getMediaShortLink, leadAttachmentCount } from '@/lib/scheduler/media-link'

// Free Online Estimate → Service Fusion. On submit we create a $0 SF ESTIMATE
// (SF derives total from line items, so an estimate with none is $0) that the
// office edits/prices later. The customer's inputs + photo/video links go into
// the estimate description so the rep has full context. Best-effort: if SF
// rejects it, the lead stays a review-only Action Item (nothing is lost).

function db(): SupabaseClient {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

interface EstimateLead {
  id: string
  service_type: string        // DB: 'garage_door' | 'gate'
  service_category: string    // DB: 'door_panel_replacement' etc.
  diagnostic_answers: Record<string, string | undefined>
  customer_first_name: string
  customer_last_name: string | null
  customer_phone: string
  customer_email: string | null
  address_line1: string
  address_line2: string | null
  address_city: string
  address_state: string
  address_zip: string
  description: string | null
  additional_notes: string | null
  address_is_owner: boolean | null
}

const CATEGORY_LABELS: Record<string, string> = {
  door_panel_replacement: 'Door / Panel Replacement',
  opener_service: 'Opener Service / Replacement',
}
const DIAG_LABELS: Record<string, Record<string, string>> = {
  replacement_type: { basic_functional: 'Basic & Functional', nicer_more_features: 'Nicer with More Features', not_sure: 'Not sure' },
  estimated_age: { less_than_8_years: 'Less than 8 years', '8_years_or_older': '8 years or older', not_sure: 'Not sure' },
  multiple_doors: { yes: 'Yes', no: 'No' },
  opener_need: { repair_existing: 'Repair existing', replace: 'Replace', add_opener: 'Add opener', not_sure: 'Not sure' },
}

/**
 * Create a $0 SF estimate for an online-estimate lead. Never throws — returns
 * whether it succeeded so the caller can leave the lead review-only on failure.
 */
export async function createOnlineEstimateInSf(leadId: string): Promise<{ ok: boolean; estimateNumber?: string; error?: string }> {
  const supabase = db()
  const { data, error } = await supabase.from('scheduler_leads').select('*').eq('id', leadId).single()
  if (error || !data) return { ok: false, error: 'lead not found' }
  const l = data as unknown as EstimateLead

  try {
    // 1. Match or create the SF customer.
    let sfCustomerId = await findExistingSfCustomer(supabase, l.customer_email ?? '', l.customer_phone)
    if (sfCustomerId) {
      await updateExistingCustomerContactInfo(sfCustomerId, {
        customer_first_name: l.customer_first_name,
        customer_last_name: l.customer_last_name ?? '',
        customer_phone: l.customer_phone,
        customer_email: l.customer_email ?? '',
        address_line1: l.address_line1,
        address_line2: l.address_line2,
        address_city: l.address_city,
        address_state: l.address_state,
        address_zip: l.address_zip,
      }).catch(() => { /* non-fatal */ })
    } else {
      const customerPayload = {
        customer_name: l.customer_last_name ? `${l.customer_first_name} ${l.customer_last_name}` : l.customer_first_name,
        contacts: [{
          fname: l.customer_first_name, lname: l.customer_last_name || '.', is_primary: 1,
          phones: [{ phone: l.customer_phone, type: 'Mobile' }],
          ...(l.customer_email ? { emails: [{ email: l.customer_email }] } : {}),
        }],
        locations: [{
          street_1: l.address_line1, ...(l.address_line2 ? { street_2: l.address_line2 } : {}),
          city: l.address_city, state_prov: l.address_state, postal_code: l.address_zip,
        }],
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const custResp = (await sfPost('/customers', customerPayload)) as any
      sfCustomerId = String(custResp?.id ?? custResp?.customer?.id ?? '')
      if (!sfCustomerId || sfCustomerId === 'undefined') throw new Error('No customer ID returned from Service Fusion')
    }

    // 2. Build the description from the customer's inputs + media links.
    const diag = l.diagnostic_answers ?? {}
    const lines: string[] = []
    lines.push('*** ONLINE ESTIMATE REQUEST — needs pricing ***')
    lines.push(`Service: Garage Door — ${CATEGORY_LABELS[l.service_category] ?? l.service_category}`)
    if (diag.replacement_type) lines.push(`Looking for: ${DIAG_LABELS.replacement_type[diag.replacement_type] ?? diag.replacement_type}`)
    if (diag.estimated_age) lines.push(`Door age: ${DIAG_LABELS.estimated_age[diag.estimated_age] ?? diag.estimated_age}`)
    if (diag.multiple_doors) lines.push(`Multiple doors: ${DIAG_LABELS.multiple_doors[diag.multiple_doors] ?? diag.multiple_doors}`)
    if (diag.opener_need) lines.push(`Opener need: ${DIAG_LABELS.opener_need[diag.opener_need] ?? diag.opener_need}`)
    if (l.description) lines.push(`Customer note: ${l.description}`)
    if (l.additional_notes) lines.push(`Additional notes: ${l.additional_notes}`)
    if (l.address_is_owner === false) lines.push('Property owner: No (renter/tenant)')

    // One short, login-gated link to the customer's photos/video (private
    // bucket) instead of a wall of long signed URLs.
    const mediaCount = await leadAttachmentCount(supabase, l.id).catch(() => 0)
    if (mediaCount > 0) {
      const mediaUrl = await getMediaShortLink(l.id).catch(() => null)
      if (mediaUrl) lines.push(`Customer photos & video (${mediaCount}): ${mediaUrl}`)
    }
    lines.push(`Lead ID: ${l.id}`)

    // 3. Create the $0 estimate (no line items ⇒ $0). Ask for id + number back.
    const estimatePayload = {
      customer_name: parseInt(sfCustomerId, 10),
      contact_first_name: l.customer_first_name,
      contact_last_name: l.customer_last_name || '.',
      street_1: l.address_line1,
      ...(l.address_line2 ? { street_2: l.address_line2 } : {}),
      city: l.address_city,
      state_prov: l.address_state,
      postal_code: l.address_zip,
      description: lines.join('\n'),
      tech_notes: 'Preliminary online estimate — subject to onsite verification.',
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const estResp = (await sfPost('/estimates?fields=id,number', estimatePayload)) as any
    const estimateId = String(estResp?.id ?? estResp?.estimate?.id ?? estResp?.data?.id ?? '')
    const estimateNumber = String(estResp?.number ?? estResp?.estimate?.number ?? '')
    if (!estimateId || estimateId === 'undefined') throw new Error(`No estimate ID returned: ${JSON.stringify(estResp)}`)

    await supabase.from('scheduler_leads').update({
      sync_status: 'synced',
      service_fusion_customer_id: sfCustomerId,
      service_fusion_estimate_id: estimateId,
      service_fusion_estimate_number: estimateNumber || null,
      synced_at: new Date().toISOString(),
    }).eq('id', leadId)

    return { ok: true, estimateNumber: estimateNumber || undefined }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[online-estimate] SF estimate creation failed for ${leadId}:`, message)
    // Review-only: the lead still appears in the Action Items tab for manual handling.
    try { await supabase.from('scheduler_leads').update({ sync_status: 'sync_failed' }).eq('id', leadId) } catch { /* ignore */ }
    return { ok: false, error: message }
  }
}
