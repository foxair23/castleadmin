import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { sendEmail } from '@/lib/notifications/resend'
import { sendSms, toE164, isDialpadConfigured } from '@/lib/dialpad/client'
import { greetingFirstName } from '@/lib/names'
import { appUrl } from '@/lib/config/domains'
import { ensureShortLink } from '@/lib/short-links'
import { enqueueNote } from '@/lib/sf-notes/queue'
import { renderEsignCustomerEmail, renderEsignCustomerSms } from '@/lib/notifications/templates/esign-request'
import { templateByKey, type TemplateService } from './templates'
import { customerStageDue, ptDay, ptHour, type CustomerStage } from './eligibility'
import { getEsignSettings } from './settings'
import { prepareEsignDoc } from './prepare'
import { linkMissingEsignJobs } from './job-link'
import { refreshJob } from '@/lib/agent/live-refresh'
import { deriveWork } from './work'

// The customer sender. An hourly sweep (business hours PT) walks the documents that are
// prepared or already with the customer, asks eligibility.ts which message — if any — is due
// for each, and sends it by email and SMS. Every message is stamped once. Guards, in order:
//   • the setting is ON and the document was found after enabled_at (never the backlog)
//   • the house's SF job is in the mirror with a start date (that date drives everything)
//   • the order is active, and there is somewhere to send to
//   • the SMS honours the shared opt-out list; STOP is in the body
// "Send now" from the Signatures page bypasses the setting and the cutoff (an explicit
// send is a decision), not the contact/opt-out rules.

const VENDOR = 'clopay_hd'
const DOC_TYPE = 'lien_waiver'
const SEND_CAP = 25
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}
const isActive = (status: string | null) => { const s = (status || '').toLowerCase(); return !s.startsWith('cancel') && !s.startsWith('clos') }

export const signLink = (token: string) => `${appUrl()}/sign/${token}`

interface DocRow {
  id: string; order_id: string; status: string; template_key: string | null; sf_job_id: string | null; customer_token: string; created_at: string
  customer_sent_at: string | null; customer_asked_at: string | null; customer_reminded_at: string | null; customer_signed_at: string | null
}
interface OrderRow { id: string; external_id: string | null; customer_name: string | null; phone: string | null; email: string | null; status: string | null; sf_job_id: string | null }

const DOC_COLS = 'id, order_id, status, template_key, sf_job_id, customer_token, created_at, customer_sent_at, customer_asked_at, customer_reminded_at, customer_signed_at'

/** Send one stage's email + SMS to the customer and stamp it. A failed email does not block the SMS. */
export async function deliverToCustomer(supabase: SupabaseClient, doc: DocRow, order: OrderRow, stage: CustomerStage): Promise<{ channels: string[]; error?: string }> {
  const service: TemplateService = templateByKey(doc.template_key)?.service ?? 'install'
  const channels: string[] = []
  let error: string | undefined
  const greetingName = greetingFirstName({ customerName: order.customer_name })
  const link = signLink(doc.customer_token)

  if (order.email) {
    try {
      const { subject, html, text } = renderEsignCustomerEmail(stage, service, { greetingName, link })
      await sendEmail({ to: order.email, subject, html, text })
      channels.push('email')
    } catch (e) { error = `email: ${e instanceof Error ? e.message : String(e)}` }
  }
  const e164 = toE164(order.phone)
  if (e164 && isDialpadConfigured()) {
    const { data: opt } = await supabase.from('invoice_reminder_optouts').select('value').eq('channel', 'sms').eq('value', e164).maybeSingle()
    if (!opt) {
      const short = await ensureShortLink(link)
      const res = await sendSms(e164, renderEsignCustomerSms(stage, service, { greetingName, link: short }))
      if (res.ok) channels.push('sms')
      else error = `${error ? error + '; ' : ''}sms: ${res.error ?? 'failed'}`
    }
  }

  if (channels.length) {
    const now = new Date().toISOString()
    const patch: Record<string, unknown> = { updated_at: now }
    if (stage === 'heads_up') { patch.customer_sent_at = now; patch.customer_sent_channels = channels.join(','); patch.status = 'sent_customer' }
    else if (stage === 'ask') { patch.customer_asked_at = now; if (!doc.customer_sent_at) { patch.customer_sent_at = now; patch.customer_sent_channels = channels.join(',') }; patch.status = 'sent_customer' }
    else patch.customer_reminded_at = now
    await supabase.from('esign_documents').update(patch).eq('id', doc.id)
    await supabase.from('vendor_order_events').insert({ order_id: doc.order_id, event_type: `esign_customer_${stage}`, to_value: channels.join(','), detail: { doc_id: doc.id, service } })
    if (doc.sf_job_id) {
      const what = stage === 'heads_up' ? 'link sent ahead of the work' : stage === 'ask' ? 'asked to sign' : 'reminded to sign'
      await enqueueNote({ sfJobId: doc.sf_job_id, noteText: `E-sign: Home Depot ${service === 'delivery' ? 'proof-of-delivery' : 'completion'} form — customer ${what} (${channels.join(', ')}).`, event: 'esign_customer', dedupKey: `esign:${doc.id}:${stage}`, refTable: 'esign_documents', refId: doc.id })
    }
  }
  return { channels, error }
}

export interface EsignSweepResult { enabled: boolean; looked: number; sent: number; failed: number; held: number; errors: string[] }

/** Hourly: send whichever customer message is due. */
export async function runEsignCustomerSweep(now = new Date()): Promise<EsignSweepResult> {
  const s = await getEsignSettings(VENDOR, DOC_TYPE)
  const out: EsignSweepResult = { enabled: s.enabled, looked: 0, sent: 0, failed: 0, held: 0, errors: [] }
  if (!s.enabled || !s.enabledAt) return out
  const supabase = db()
  // Jobs get booked after the blank shows up; find them first so today's installs are seen.
  await linkMissingEsignJobs(supabase)
  const { data: docs } = await supabase.from('esign_documents').select(DOC_COLS)
    .eq('vendor', VENDOR).eq('doc_type', DOC_TYPE).in('status', ['found', 'prepared', 'sent_customer']).is('customer_signed_at', null)
    .gte('created_at', s.enabledAt).order('created_at', { ascending: true }).limit(200)
  const rows = (docs ?? []) as DocRow[]
  if (!rows.length) return out
  const { data: orders } = await supabase.from('vendor_orders').select('id, external_id, customer_name, phone, email, status, sf_job_id').in('id', rows.map(r => r.order_id))
  const orderById = new Map(((orders ?? []) as OrderRow[]).map(o => [o.id, o]))
  const jobIds = [...new Set(rows.map(r => r.sf_job_id ?? orderById.get(r.order_id)?.sf_job_id).filter((v): v is string => !!v))]
  const { data: jobs } = jobIds.length ? await supabase.from('sf_jobs').select('id, start_date').in('id', jobIds) : { data: [] }
  const startByJob = new Map((jobs ?? []).map((j: { id: string | number; start_date: string | null }) => [String(j.id), j.start_date]))
  const today = ptDay(now), hour = ptHour(now)

  for (const doc of rows) {
    if (out.sent + out.failed >= SEND_CAP) break
    out.looked++
    const order = orderById.get(doc.order_id)
    if (!order || !isActive(order.status) || (!order.email && !order.phone)) { out.held++; continue }
    const jobId = doc.sf_job_id ?? order.sf_job_id ?? null
    let start = jobId ? startByJob.get(String(jobId)) ?? null : null
    let status = doc.status
    // The work's real stage comes from the live job (its visits and their completion), not
    // the mirror's single date: a Clopay install's site check must never trigger the form.
    let phase: 'inspection' | 'install' | 'delivery' | 'unknown' | undefined
    let completed: boolean | undefined
    if (jobId) {
      const live = await refreshJob(String(jobId))
      if (live.status === 'fresh') {
        const w = deriveWork(live.facts, templateByKey(doc.template_key)?.service ?? 'install')
        phase = w.phase; completed = w.completed; start = w.workDate ?? start
      } else { out.held++; out.errors.push(`order ${order.external_id}: live read failed (${live.error})`); continue }
    }
    // A blank that has not been inspected yet is prepared inline, so a same-day install is not missed.
    if (status === 'found') {
      const r = await prepareEsignDoc(doc.id, supabase)
      if (!r.ok || r.status !== 'prepared') { out.held++; continue }
      status = 'prepared'; doc.template_key = r.template ?? doc.template_key
    }
    const stage = customerStageDue({ ...doc, status, start_date: start, phase, completed, enabled_at: s.enabledAt, today, hour })
    if (!stage) { out.held++; continue }
    try {
      const { channels, error } = await deliverToCustomer(supabase, { ...doc, sf_job_id: jobId }, order, stage)
      if (channels.length) out.sent++; else out.failed++
      if (error) out.errors.push(`order ${order.external_id}: ${error}`)
    } catch (e) {
      out.failed++; out.errors.push(`order ${order.external_id}: ${e instanceof Error ? e.message : String(e)}`)
    }
    await sleep(1200)
  }
  return out
}

/** Manual send from the Signatures page: any stage, regardless of the setting or cutoff. */
export async function sendEsignNowForDoc(docId: string, stage: CustomerStage): Promise<{ ok: boolean; channels?: string[]; error?: string; warning?: string }> {
  const supabase = db()
  const { data: d } = await supabase.from('esign_documents').select(DOC_COLS).eq('id', docId).maybeSingle()
  if (!d) return { ok: false, error: 'Document not found.' }
  let doc = d as DocRow
  if (doc.customer_signed_at) return { ok: false, error: 'The customer has already signed.' }
  if (['completed', 'sf_uploaded', 'portal_uploaded', 'cancelled', 'tech_signed', 'sent_tech', 'customer_signed'].includes(doc.status)) return { ok: false, error: `Nothing to send at status "${doc.status}".` }
  if (doc.status === 'found' || doc.status === 'unrecognised_template') {
    const r = await prepareEsignDoc(docId, supabase)
    if (!r.ok || r.status !== 'prepared') return { ok: false, error: r.error ?? 'This form version is not pinned yet — it cannot be sent.' }
    const { data: again } = await supabase.from('esign_documents').select(DOC_COLS).eq('id', docId).maybeSingle()
    doc = again as DocRow
  }
  const { data: order } = await supabase.from('vendor_orders').select('id, external_id, customer_name, phone, email, status, sf_job_id').eq('id', doc.order_id).maybeSingle()
  if (!order) return { ok: false, error: 'Order not found.' }
  if (!order.email && !order.phone) return { ok: false, error: 'No phone or email on this order.' }
  try {
    const { channels, error } = await deliverToCustomer(supabase, { ...doc, sf_job_id: doc.sf_job_id ?? order.sf_job_id ?? null }, order as OrderRow, stage)
    if (!channels.length) return { ok: false, error: error ?? 'Nothing sent (opted out / no reachable channel).' }
    return { ok: true, channels, warning: error }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
