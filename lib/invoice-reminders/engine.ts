import { createClient } from '@supabase/supabase-js'
import { todayPT } from '@/lib/action-items/config'
import { sfGet } from '@/lib/crm/service-fusion'
import { sendEmail } from '@/lib/notifications/resend'
import { sendSms, toE164, isDialpadConfigured } from '@/lib/dialpad/client'
import { renderInvoiceReminderEmail } from '@/lib/notifications/templates/invoice-reminder-email'

const BUSINESS_NAME = 'Castle Garage Inc'

export interface CadenceStage {
  day: number
  channels: ('email' | 'sms')[]
  email_subject: string
  email_body: string
  sms_body: string
}
export interface ReminderSettings {
  enabled: boolean
  activated_at: string | null
  send_hour_pt: number
  excluded_sources: string[]
  cadence: CadenceStage[]
}

export interface PlannedSend {
  sfInvoiceId: string
  sfJobId: string | null
  invoiceNumber: string | null
  customerName: string | null
  stageIndex: number
  stageDay: number
  channel: 'email' | 'sms'
  recipient: string
  amountDue: number
  payUrl: string | null
}

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

export async function loadSettings(): Promise<ReminderSettings> {
  const { data } = await db().from('invoice_reminder_settings').select('*').eq('id', 1).maybeSingle()
  const s = (data ?? {}) as Partial<ReminderSettings>
  return {
    enabled: s.enabled ?? false,
    activated_at: s.activated_at ?? null,
    send_hour_pt: s.send_hour_pt ?? 9,
    excluded_sources: s.excluded_sources ?? [],
    cadence: (s.cadence as CadenceStage[]) ?? [],
  }
}

function money(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

/** Add `n` days to a 'YYYY-MM-DD' string, returning 'YYYY-MM-DD' (UTC-safe). */
function addDaysYmd(ymd: string, n: number): string {
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? '')
}

interface InvoiceRow {
  id: string; job_id: string | null; number: string | null; date: string | null
  total: number | null; raw_data: Record<string, unknown>
}
interface JobRow { id: string; source: string | null; due_total: number | null; customer_name: string | null; customer_id: string | null }

/**
 * Compute exactly what would be sent today. Fresh-start: a stage only fires if
 * its due date falls on/after activated_at, so enabling never chases the
 * backlog. Only the single most-advanced due stage per invoice is considered.
 */
export async function getPlannedSends(settings: ReminderSettings): Promise<PlannedSend[]> {
  const supabase = db()
  const today = todayPT()
  const activatedDate = settings.activated_at ? settings.activated_at.slice(0, 10) : today
  if (settings.cadence.length === 0) return []

  // Unpaid, non-deleted invoices.
  const invoices: InvoiceRow[] = []
  let from = 0
  const PAGE = 1000
  for (;;) {
    const { data: page } = await supabase
      .from('sf_invoices')
      .select('id, job_id, number, date, total, raw_data')
      .eq('is_paid', false)
      .eq('is_deleted', false)
      .order('id')
      .range(from, from + PAGE - 1)
    if (!page || page.length === 0) break
    invoices.push(...(page as InvoiceRow[]))
    if (page.length < PAGE) break
    from += PAGE
  }
  if (invoices.length === 0) return []

  const jobIds = [...new Set(invoices.map(i => i.job_id).filter((j): j is string => !!j))]
  const { data: jobRows } = await supabase
    .from('sf_jobs').select('id, source, due_total, customer_name, customer_id').in('id', jobIds.length ? jobIds : ['__none__'])
  const jobMap = new Map((jobRows ?? []).map(j => [(j as JobRow).id, j as JobRow]))

  // Customer fallback contacts.
  const custIds = [...new Set((jobRows ?? []).map(j => (j as JobRow).customer_id).filter((c): c is string => !!c))]
  const { data: custRows } = await supabase
    .from('sf_customers').select('id, raw_data').in('id', custIds.length ? custIds : ['__none__'])
  const custMap = new Map((custRows ?? []).map(c => [(c as { id: string }).id, (c as { raw_data: Record<string, unknown> }).raw_data]))

  // Already-sent (invoice, stage, channel), skips, opt-outs.
  const invIds = invoices.map(i => i.id)
  const [{ data: sentRows }, { data: skipRows }, { data: optRows }] = await Promise.all([
    supabase.from('invoice_reminders').select('sf_invoice_id, stage_index, channel').in('sf_invoice_id', invIds),
    supabase.from('invoice_reminder_skips').select('sf_invoice_id'),
    supabase.from('invoice_reminder_optouts').select('channel, value'),
  ])
  const sentKeys = new Set((sentRows ?? []).map(r => `${r.sf_invoice_id}|${r.stage_index}|${r.channel}`))
  const skipSet = new Set((skipRows ?? []).map(r => (r as { sf_invoice_id: string }).sf_invoice_id))
  const optSet = new Set((optRows ?? []).map(r => `${r.channel}|${(r.value as string).toLowerCase()}`))
  const excluded = new Set(settings.excluded_sources.map(s => s.toLowerCase()))

  const plan: PlannedSend[] = []
  for (const inv of invoices) {
    if (skipSet.has(inv.id)) continue
    const job = inv.job_id ? jobMap.get(inv.job_id) : undefined
    if (!job) continue // no job link → can't verify source; skip
    if (job.source && excluded.has(job.source.toLowerCase())) continue
    const amountDue = job.due_total ?? inv.total ?? 0
    if (amountDue <= 0) continue
    const invoiceDate = (inv.date ?? '').slice(0, 10)
    if (!invoiceDate) continue

    // Most-advanced stage whose due date is within [activatedDate, today].
    let target: { index: number; stage: CadenceStage } | null = null
    settings.cadence.forEach((stage, index) => {
      const dueDate = addDaysYmd(invoiceDate, stage.day)
      if (dueDate <= today && dueDate >= activatedDate) {
        if (!target || stage.day >= target.stage.day) target = { index, stage }
      }
    })
    if (!target) continue
    const tgt: { index: number; stage: CadenceStage } = target

    const raw = inv.raw_data ?? {}
    const cust = job.customer_id ? (custMap.get(job.customer_id) ?? {}) : {}
    const email = (
      (raw['bill_to_email_id'] as string) || (cust['email'] as string) || ''
    ).trim().toLowerCase() || null
    const phone = toE164((raw['bill_to_phone_id'] as string) || (cust['phone'] as string) || null)
    const payUrl = (raw['pay_online_url'] as string) || null

    // Channel resolution: email is primary when the customer has one. SMS is the
    // fallback when they don't (for an email stage), and is also sent alongside
    // email when SMS is explicitly checked (the "both" escalation).
    const wantsEmail = tgt.stage.channels.includes('email')
    const wantsSms = tgt.stage.channels.includes('sms')
    const smsFallback = wantsEmail && !wantsSms && !email // email stage + no email → text instead
    const channelsToSend: ('email' | 'sms')[] = []
    if (wantsEmail && email) channelsToSend.push('email')
    if ((wantsSms || smsFallback) && phone) channelsToSend.push('sms')

    for (const channel of channelsToSend) {
      if (sentKeys.has(`${inv.id}|${tgt.index}|${channel}`)) continue
      const recipient = (channel === 'email' ? email : phone) as string
      if (optSet.has(`${channel}|${recipient.toLowerCase()}`)) continue
      if (channel === 'sms' && !isDialpadConfigured()) continue // SMS dormant until Dialpad is set up
      plan.push({
        sfInvoiceId: inv.id,
        sfJobId: inv.job_id,
        invoiceNumber: inv.number,
        customerName: job.customer_name,
        stageIndex: tgt.index,
        stageDay: tgt.stage.day,
        channel,
        recipient,
        amountDue,
        payUrl,
      })
    }
  }
  return plan
}

/** Live SF re-check: is this invoice still unpaid? Fails open (returns true) on SF error. */
async function stillUnpaid(sfInvoiceId: string): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = (await sfGet(`/invoices/${encodeURIComponent(sfInvoiceId)}`, { fields: 'is_paid' })) as any
    const inv = resp?.id ? resp : (resp?.items?.[0] ?? resp?.data ?? resp)
    return inv?.is_paid !== true
  } catch {
    return true // don't block sends on an SF hiccup; mirror already said unpaid
  }
}

export interface RunResult { enabled: boolean; planned: number; sent: number; failed: number; skippedPaid: number }

export async function runReminders(): Promise<RunResult> {
  const settings = await loadSettings()
  if (!settings.enabled) return { enabled: false, planned: 0, sent: 0, failed: 0, skippedPaid: 0 }

  const plan = await getPlannedSends(settings)
  const supabase = db()
  const paidCache = new Map<string, boolean>()
  let sent = 0, failed = 0, skippedPaid = 0

  for (const p of plan) {
    // Re-check paid once per invoice.
    let unpaid = paidCache.get(p.sfInvoiceId)
    if (unpaid === undefined) { unpaid = await stillUnpaid(p.sfInvoiceId); paidCache.set(p.sfInvoiceId, unpaid) }
    if (!unpaid) { skippedPaid++; continue }

    const stage = settings.cadence[p.stageIndex]
    if (!stage) { continue }
    const vars = {
      customer: p.customerName ?? 'there',
      invoice_number: p.invoiceNumber ?? p.sfInvoiceId,
      amount_due: money(p.amountDue),
      pay_url: p.payUrl ?? '',
      business_name: BUSINESS_NAME,
    }

    let ok = false
    let providerId: string | null = null
    let error: string | null = null
    try {
      if (p.channel === 'email') {
        const { html, text } = renderInvoiceReminderEmail({
          bodyText: renderTemplate(stage.email_body, vars),
          invoiceNumber: vars.invoice_number,
          amountDue: vars.amount_due,
          payUrl: p.payUrl ?? '',
        })
        await sendEmail({ to: p.recipient, subject: renderTemplate(stage.email_subject, vars), html, text })
        ok = true
      } else {
        const res = await sendSms(p.recipient, renderTemplate(stage.sms_body, vars))
        ok = res.ok
        providerId = res.messageId
        if (!res.ok) {
          error = res.error ?? 'sms failed'
          // Dialpad handles STOP internally and often doesn't forward it to our
          // webhook — so a send can be rejected for opt-out without us knowing.
          // Detect that from the rejection and record the opt-out ourselves so
          // we stop trying. Belt-and-suspenders alongside the inbound webhook.
          if (/opt.?out|unsubscrib|\bstop\b|consent|blocked|not.*subscrib|do.?not.?(text|contact|message)/i.test(error)) {
            await supabase.from('invoice_reminder_optouts')
              .upsert({ channel: 'sms', value: p.recipient, reason: 'stop' }, { onConflict: 'channel,value' })
          }
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }

    await supabase.from('invoice_reminders').insert({
      sf_invoice_id: p.sfInvoiceId,
      sf_job_id: p.sfJobId,
      stage_index: p.stageIndex,
      stage_day: p.stageDay,
      channel: p.channel,
      recipient: p.recipient,
      status: ok ? 'sent' : 'failed',
      provider_message_id: providerId,
      error,
      amount_due: p.amountDue,
      pay_url: p.payUrl,
    })
    if (ok) sent++; else failed++
  }

  return { enabled: true, planned: plan.length, sent, failed, skippedPaid }
}
