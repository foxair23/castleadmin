import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { sfPost, sfGet } from '@/lib/crm/service-fusion'
import { findExistingSfCustomer } from '@/lib/scheduler/sf-customer-match'
import { getVendor } from './config'

// Phase 2: create the Service Fusion job for a vendor order, reusing the same
// SF API write path the scheduler uses (POST /customers, POST /jobs). No browser
// extension needed — SF's API accepts writes. Stores the new job id back on the
// order so the matcher links it (row goes green). Idempotent: refuses if the
// order already has an sf_job_id.

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

interface OrderRow {
  id: string; vendor: string; external_id: string; sf_job_id: string | null
  customer_name: string | null; customer_po: string | null; store_number: string | null
  order_type: string | null; scope: string | null
  street_address: string | null; city: string | null; state_prov: string | null; postal_code: string | null
  phone: string | null; email: string | null
}

/** "SERRANO, GLORIA" or "Gloria Serrano" → { first, last }. */
function parseName(name: string | null): { first: string; last: string } {
  const s = (name ?? '').trim()
  if (!s) return { first: '', last: '.' }
  if (s.includes(',')) {
    const [last, first] = s.split(',').map(x => x.trim())
    return { first: first || last, last: last || '.' }
  }
  const parts = s.split(/\s+/)
  if (parts.length === 1) return { first: parts[0], last: '.' }
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] }
}

function buildDescription(o: OrderRow, vendorLabel: string): string {
  const lines: string[] = []
  if (o.scope) lines.push(o.scope)
  lines.push(`Source: ${vendorLabel}`)
  if (o.external_id) lines.push(`Home Depot Order #: ${o.external_id}`)
  if (o.store_number) lines.push(`Home Depot Store #: ${o.store_number}`)
  if (o.customer_po) lines.push(`PO #: ${o.customer_po}`)
  if (o.order_type) lines.push(`Order type: ${o.order_type}`)
  return lines.join('\n')
}

/** Pick an "open/new" job status id+name from SF. */
async function pickStatus(): Promise<{ id: number; name: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resp = (await sfGet('/job-statuses', { 'per-page': '50' })) as any
  const statuses: { id: number; name: string }[] = resp?.items ?? []
  const open = statuses.find(s => /pending|open|new|schedul/i.test(s.name)) ?? statuses[0]
  if (!open) throw new Error('No job statuses found in Service Fusion')
  return open
}

export interface CreateJobResult { ok: boolean; sfJobId?: string; error?: string }

export async function createSfJobForOrder(orderId: string): Promise<CreateJobResult> {
  const supabase = db()
  const { data: order } = await supabase
    .from('vendor_orders')
    .select('id, vendor, external_id, sf_job_id, customer_name, customer_po, store_number, order_type, scope, street_address, city, state_prov, postal_code, phone, email')
    .eq('id', orderId).maybeSingle()
  if (!order) return { ok: false, error: 'order not found' }
  const o = order as OrderRow
  if (o.sf_job_id) return { ok: false, error: 'order already linked to an SF job' }

  const vendor = getVendor(o.vendor)
  const name = parseName(o.customer_name)

  try {
    // 1. Find an existing SF customer by email/phone, else create one.
    let sfCustomerId = await findExistingSfCustomer(supabase, o.email, o.phone).catch(() => null)
    if (!sfCustomerId) {
      const customerPayload = {
        customer_name: [name.first, name.last].filter(x => x && x !== '.').join(' ') || o.customer_name || o.external_id,
        contacts: [{
          fname: name.first, lname: name.last || '.', is_primary: 1,
          ...(o.phone ? { phones: [{ phone: o.phone, type: 'Mobile' }] } : {}),
          ...(o.email ? { emails: [{ email: o.email }] } : {}),
        }],
        locations: [{ street_1: o.street_address, city: o.city, state_prov: o.state_prov, postal_code: o.postal_code }],
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const custResp = (await sfPost('/customers', customerPayload)) as any
      sfCustomerId = String(custResp?.id ?? custResp?.customer?.id ?? '')
      if (!sfCustomerId || sfCustomerId === 'undefined') return { ok: false, error: 'no customer id returned from SF' }
    }

    // 2. Create the job.
    const status = await pickStatus()

    // Custom fields set by name (per the SF API: custom_fields: [{ name, value }]).
    // Only include ones we actually have a value for.
    const customFields = (vendor?.sfCustomFields ?? [])
      .map(cf => ({ name: cf.sfFieldName, value: (o as unknown as Record<string, unknown>)[cf.from] }))
      .filter(cf => cf.value != null && cf.value !== '')
    // Service line items every job of this vendor gets (SF: services: [{ name, multiplier }]).
    const services = (vendor?.sfServiceLines ?? []).map(s => ({ name: s.name, multiplier: s.quantity ?? 1 }))

    const jobPayload: Record<string, unknown> = {
      customer_name: parseInt(String(sfCustomerId), 10),
      contact_first_name: name.first,
      contact_last_name: name.last || '.',
      street_1: o.street_address,
      city: o.city,
      state_prov: o.state_prov,
      postal_code: o.postal_code,
      status: status.name,
      ...(vendor?.sfJobSource ? { source: vendor.sfJobSource } : {}),
      ...(o.customer_po ? { po_number: o.customer_po } : {}),
      description: buildDescription(o, vendor?.label ?? 'Genie'),
      ...(customFields.length ? { custom_fields: customFields } : {}),
      ...(services.length ? { services } : {}),
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let jobResp: any
    try {
      jobResp = await sfPost('/jobs', jobPayload)
    } catch (postErr) {
      // Retry once without `source` on a 4xx (SF doesn't recognize the source);
      // never blind-retry on 5xx (SF may have already created the job).
      const msg = postErr instanceof Error ? postErr.message : String(postErr)
      if (/\(4\d\d\)/.test(msg) && 'source' in jobPayload) {
        const retry = { ...jobPayload }; delete retry.source
        jobResp = await sfPost('/jobs', retry)
      } else {
        throw postErr
      }
    }
    const sfJobId = String(jobResp?.id ?? jobResp?.job?.id ?? jobResp?.data?.id ?? '')
    if (!sfJobId || sfJobId === 'undefined') return { ok: false, error: `no job id returned from SF: ${JSON.stringify(jobResp).slice(0, 200)}` }

    // 3. Link it back + log.
    await supabase.from('vendor_orders').update({ sf_job_id: sfJobId, updated_at: new Date().toISOString() }).eq('id', orderId)
    await supabase.from('vendor_order_events').insert({ order_id: orderId, event_type: 'sf_job_created', to_value: sfJobId, detail: { customerId: sfCustomerId } })
    return { ok: true, sfJobId }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
