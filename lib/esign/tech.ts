import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { sendEmail } from '@/lib/notifications/resend'
import { sendSms, toE164, isDialpadConfigured } from '@/lib/dialpad/client'
import { enqueueForSubscribers } from '@/lib/notifications/enqueue'
import { ensureShortLink } from '@/lib/short-links'
import { enqueueNote } from '@/lib/sf-notes/queue'
import { appUrl } from '@/lib/config/domains'
import { renderEsignTechSms, renderEsignTechEmail } from '@/lib/notifications/templates/esign-request'
import { templateByKey } from './templates'

// The technician's turn. After the customer signs, the tech assigned to the SF job (mirror:
// sf_job_techs → sf_techs) gets a text and an email with their link. No tech on the job yet →
// try again every sweep and tell the office once a day. One reminder to the tech after 24h.

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}
const DAY = 24 * 3600_000

export interface TechContact { id: string | null; name: string; phone: string | null; email: string | null }

/** The first assigned tech with a way to reach them. */
export async function resolveTechForJob(sfJobId: string, supabase: SupabaseClient = db()): Promise<TechContact | null> {
  const { data: links } = await supabase.from('sf_job_techs').select('tech_id, tech_first_name, tech_last_name').eq('job_id', sfJobId)
  if (!links?.length) return null
  const ids = links.map(l => String(l.tech_id))
  const { data: techs } = await supabase.from('sf_techs').select('id, first_name, last_name, email, phone_1, phone_2').in('id', ids)
  for (const l of links) {
    const t = (techs ?? []).find(x => String(x.id) === String(l.tech_id))
    const name = [t?.first_name ?? l.tech_first_name, t?.last_name ?? l.tech_last_name].filter(Boolean).join(' ') || `Tech ${l.tech_id}`
    const phone = (t?.phone_1 as string | null) || (t?.phone_2 as string | null) || null
    const email = (t?.email as string | null) || null
    if (phone || email) return { id: String(l.tech_id), name, phone, email }
  }
  return null
}

interface Ctx { doc: Record<string, unknown>; jobNumber: string | null; customerName: string; address: string }
async function load(supabase: SupabaseClient, docId: string): Promise<Ctx | null> {
  const { data: doc } = await supabase.from('esign_documents').select('*').eq('id', docId).maybeSingle()
  if (!doc) return null
  const prefill = (doc.prefill ?? {}) as Record<string, string>
  let jobNumber: string | null = prefill.sf_job_number ?? null
  if (!jobNumber && doc.sf_job_id) {
    const { data: j } = await supabase.from('sf_jobs').select('number').eq('id', doc.sf_job_id as string).maybeSingle()
    jobNumber = (j?.number as string | null) ?? null
  }
  return { doc, jobNumber, customerName: prefill.customer_name || 'The customer', address: prefill.address_full || '' }
}

export interface NotifyTechResult { ok: boolean; channels?: string[]; tech?: string; error?: string; alerted?: boolean }

/** Text + email the tech their link. `override` lets the office name a person by hand. */
export async function notifyTech(docId: string, opts: { override?: TechContact; reminder?: boolean } = {}, supabase: SupabaseClient = db()): Promise<NotifyTechResult> {
  const ctx = await load(supabase, docId)
  if (!ctx) return { ok: false, error: 'Document not found.' }
  const { doc } = ctx
  if (!['customer_signed', 'sent_tech'].includes(doc.status as string)) return { ok: false, error: `Nothing to send at status "${doc.status}".` }
  const sfJobId = doc.sf_job_id as string | null
  const tech = opts.override ?? (sfJobId ? await resolveTechForJob(sfJobId, supabase) : null)
  const now = new Date().toISOString()
  if (!tech) {
    // Once a day, tell the office; the sweep keeps trying in between.
    const last = doc.no_tech_alerted_at as string | null
    let alerted = false
    if (!last || Date.now() - new Date(last).getTime() > DAY) {
      const link = `${appUrl()}/admin/vendor-orders/signatures`
      const text = `${ctx.customerName} at ${ctx.address} has signed the Home Depot form${ctx.jobNumber ? ` for job ${ctx.jobNumber}` : ''}, but no technician with a phone or email is assigned to the job in Service Fusion, so nobody has been sent the tech signing link.\n\nAssign the tech on the job (the mirror picks it up within the hour) or send the link by hand from the Signatures page: ${link}`
      await enqueueForSubscribers({ notificationTypeKey: 'esign_office_alert', subject: `E-sign: no technician to sign — ${ctx.customerName}${ctx.jobNumber ? ` (job ${ctx.jobNumber})` : ''}`, bodyText: text, bodyHtml: `<p style="font-family:system-ui;font-size:15px;line-height:1.5">${text.replace(/\n\n/g, '</p><p style="font-family:system-ui;font-size:15px;line-height:1.5">').replace(link, `<a href="${link}">${link}</a>`)}</p>`, relatedEntityType: 'esign_documents', relatedEntityId: `${docId}:no_tech:${now.slice(0, 10)}` })
      await supabase.from('esign_documents').update({ no_tech_alerted_at: now, updated_at: now }).eq('id', docId)
      alerted = true
    }
    return { ok: false, error: 'No technician with contact details is assigned to the SF job.', alerted }
  }

  const service = templateByKey(doc.template_key as string | null)?.service ?? 'install'
  const link = `${appUrl()}/sign/${doc.tech_token as string}`
  const channels: string[] = []
  let error: string | undefined
  const e164 = toE164(tech.phone)
  if (e164 && isDialpadConfigured()) {
    const short = await ensureShortLink(link)
    const res = await sendSms(e164, (opts.reminder ? 'Reminder: ' : '') + renderEsignTechSms(service, { customerName: ctx.customerName, address: ctx.address, jobNumber: ctx.jobNumber, link: short }))
    if (res.ok) channels.push('sms'); else error = `sms: ${res.error ?? 'failed'}`
  }
  if (tech.email) {
    try {
      const m = renderEsignTechEmail(service, { customerName: ctx.customerName, address: ctx.address, jobNumber: ctx.jobNumber, link })
      await sendEmail({ to: tech.email, subject: (opts.reminder ? 'Reminder: ' : '') + m.subject, html: m.html, text: m.text })
      channels.push('email')
    } catch (e) { error = `${error ? error + '; ' : ''}email: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!channels.length) return { ok: false, error: error ?? 'No reachable channel for the technician.', tech: tech.name }

  const patch: Record<string, unknown> = { tech_id: tech.id, tech_name: tech.name, updated_at: now }
  if (opts.reminder) patch.tech_reminded_at = now
  else { patch.tech_sent_at = now; patch.tech_sent_channels = channels.join(','); patch.status = 'sent_tech' }
  await supabase.from('esign_documents').update(patch).eq('id', docId)
  await supabase.from('vendor_order_events').insert({ order_id: doc.order_id, event_type: opts.reminder ? 'esign_tech_reminded' : 'esign_tech_sent', to_value: channels.join(','), detail: { doc_id: docId, tech: tech.name } })
  if (sfJobId) await enqueueNote({ sfJobId, noteText: `E-sign: customer signed the Home Depot form; ${tech.name} ${opts.reminder ? 'reminded' : 'sent the tech signing link'} (${channels.join(', ')}).`, event: 'esign_tech', dedupKey: `esign:${docId}:tech:${opts.reminder ? 'reminder' : 'sent'}`, refTable: 'esign_documents', refId: docId })
  return { ok: true, channels, tech: tech.name, warning: error } as NotifyTechResult
}

export interface TechSweepResult { looked: number; sent: number; reminded: number; waiting: number; errors: string[] }

/** Hourly: customers who signed with no tech told yet; techs told 24h ago and still silent. */
export async function runEsignTechSweep(now = new Date()): Promise<TechSweepResult> {
  const supabase = db()
  const out: TechSweepResult = { looked: 0, sent: 0, reminded: 0, waiting: 0, errors: [] }
  const { data } = await supabase.from('esign_documents').select('id, status, tech_sent_at, tech_reminded_at')
    .in('status', ['customer_signed', 'sent_tech']).order('customer_signed_at', { ascending: true }).limit(50)
  for (const d of data ?? []) {
    out.looked++
    if (d.status === 'sent_tech') {
      if (d.tech_reminded_at || !d.tech_sent_at || now.getTime() - new Date(d.tech_sent_at as string).getTime() < DAY) continue
      const r = await notifyTech(d.id as string, { reminder: true }, supabase)
      if (r.ok) out.reminded++; else out.errors.push(`${d.id}: ${r.error}`)
      continue
    }
    const r = await notifyTech(d.id as string, {}, supabase)
    if (r.ok) out.sent++; else { out.waiting++; if (r.error && !/No technician/.test(r.error)) out.errors.push(`${d.id}: ${r.error}`) }
  }
  return out
}
