import { createClient } from '@supabase/supabase-js'
import { todayPT } from '@/lib/action-items/config'
import { sfGet } from '@/lib/crm/service-fusion'
import { sendEmail } from '@/lib/notifications/resend'
import { sendSms, toE164, isDialpadConfigured } from '@/lib/dialpad/client'
import { renderInvoiceReminderEmail } from '@/lib/notifications/templates/invoice-reminder-email'
import { greetingFirstName } from '@/lib/names'
import { ensureShortLink } from '@/lib/short-links'
import { enqueueNote } from '@/lib/sf-notes/queue'

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
  reply_to_email: string | null
}

export interface PlannedSend {
  sfInvoiceId: string
  sfJobId: string | null
  invoiceNumber: string | null
  customerName: string | null   // display, e.g. "Watts, Rian"
  greetingName: string | null   // cleaned first name for {{customer}}, e.g. "Rian"
  source: string | null         // the job's SF source (null = none set)
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
    reply_to_email: (s as { reply_to_email?: string | null }).reply_to_email ?? null,
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
interface JobRow { id: string; source: string | null; due_total: number | null; customer_name: string | null; customer_id: string | null; contact_first_name: string | null; contact_last_name: string | null }

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
    .from('sf_jobs').select('id, source, due_total, customer_name, customer_id, contact_first_name, contact_last_name').in('id', jobIds.length ? jobIds : ['__none__'])
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
  const norm = (s: string) => s.trim().toLowerCase()
  const excluded = new Set(settings.excluded_sources.map(norm))

  const plan: PlannedSend[] = []
  for (const inv of invoices) {
    if (skipSet.has(inv.id)) continue
    const job = inv.job_id ? jobMap.get(inv.job_id) : undefined
    if (!job) continue // no job link → can't verify source; skip
    if (job.source && excluded.has(norm(job.source))) continue
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
    const payUrlLong = (raw['pay_online_url'] as string) || null
    // Shorten the (very long) SF pay URL to cstle.co/p/<code> — matters most for
    // SMS, and gives click tracking. Deterministic + deduped.
    const payUrl = payUrlLong ? await ensureShortLink(payUrlLong) : null
    // Cleaned first name for the greeting (handles "Last, First" + ALL-CAPS),
    // same logic as the Mailchimp export.
    const greeting = greetingFirstName({
      firstName: job.contact_first_name ?? (cust['first_name'] as string | null),
      lastName: job.contact_last_name ?? (cust['last_name'] as string | null),
      customerName: job.customer_name,
    })

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
        greetingName: greeting,
        source: job.source ?? null,
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

function templateVars(p: {
  greetingName: string | null; invoiceNumber: string | null; sfInvoiceId: string; amountDue: number; payUrl: string | null
}): Record<string, string> {
  return {
    customer: p.greetingName ?? 'there',
    invoice_number: p.invoiceNumber ?? p.sfInvoiceId,
    amount_due: money(p.amountDue),
    pay_url: p.payUrl ?? '',
    business_name: BUSINESS_NAME,
  }
}

/** The SF job note recorded when a reminder is sent. Human-readable for the
 *  office, deduped per stage so the channel named is whichever fired first. */
function reminderNoteText(p: PlannedSend): string {
  const step = p.stageIndex + 1
  const via = p.channel === 'sms' ? 'text' : 'email'
  const inv = p.invoiceNumber ? `Invoice #${p.invoiceNumber}` : `Invoice ${p.sfInvoiceId}`
  return `Castle Admin: invoice reminder sent to customer via ${via} (series step ${step}, day ${p.stageDay}). ${inv} · ${money(p.amountDue)} due.`
}

/**
 * Render + send a single reminder on a single channel and log the result to
 * `invoice_reminders`. Shared by the automated run and manual resends; `manual`
 * flags the log row so the two never conflate. Returns whether it sent.
 */
async function deliverReminder(
  p: PlannedSend,
  stage: CadenceStage,
  settings: ReminderSettings,
  opts: { manual: boolean },
): Promise<{ ok: boolean; error: string | null }> {
  const supabase = db()
  const vars = templateVars(p)

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
      await sendEmail({ to: p.recipient, subject: renderTemplate(stage.email_subject, vars), html, text, replyTo: settings.reply_to_email || undefined })
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
    manual: opts.manual,
  })

  // Audit trail on the SF job: a note the office sees in Service Fusion whenever
  // a reminder actually goes out to the customer. Queued (not posted directly)
  // because SF has no note API — the browser extension posts it. Deduped per
  // (invoice, stage) so an email+SMS escalation logs one note, not two. Never
  // blocks or fails the send.
  if (ok && p.sfJobId) {
    await enqueueNote({
      sfJobId: p.sfJobId,
      noteText: reminderNoteText(p),
      event: 'invoice_reminder',
      dedupKey: `invoice_reminder:${p.sfInvoiceId}:${p.stageIndex}`,
      refTable: 'invoice_reminders',
      refId: p.sfInvoiceId,
    })
  }
  return { ok, error }
}

export interface RunResult { enabled: boolean; planned: number; sent: number; failed: number; skippedPaid: number }

export async function runReminders(): Promise<RunResult> {
  const settings = await loadSettings()
  if (!settings.enabled) return { enabled: false, planned: 0, sent: 0, failed: 0, skippedPaid: 0 }

  const plan = await getPlannedSends(settings)
  const paidCache = new Map<string, boolean>()
  let sent = 0, failed = 0, skippedPaid = 0

  for (const p of plan) {
    // Re-check paid once per invoice.
    let unpaid = paidCache.get(p.sfInvoiceId)
    if (unpaid === undefined) { unpaid = await stillUnpaid(p.sfInvoiceId); paidCache.set(p.sfInvoiceId, unpaid) }
    if (!unpaid) { skippedPaid++; continue }

    const stage = settings.cadence[p.stageIndex]
    if (!stage) { continue }

    const { ok } = await deliverReminder(p, stage, settings, { manual: false })
    if (ok) sent++; else failed++
  }

  return { enabled: true, planned: plan.length, sent, failed, skippedPaid }
}

// ── Manual resend ────────────────────────────────────────────────────────────
// Admin/sales can re-fire a chosen stage of the series to a single overdue
// invoice. Reuses the same rendering/sending/logging as the automated run, but
// tags the log rows `manual = true` and re-checks paid + opt-outs at send time.

/** Everything needed to render/send a reminder for one invoice, from the mirror. */
export interface ResendContext {
  sfInvoiceId: string
  sfJobId: string | null
  invoiceNumber: string | null
  customerName: string | null
  greetingName: string | null
  source: string | null
  amountDue: number
  email: string | null
  phone: string | null
  payUrl: string | null
}

/**
 * The unpaid invoice to remind on for a job. Jobs almost always have exactly
 * one; if several are unpaid, remind on the most recent (largest running
 * balance is usually the freshest invoice).
 */
export async function pickUnpaidInvoiceId(sfJobId: string): Promise<string | null> {
  const { data } = await db()
    .from('sf_invoices')
    .select('id, date')
    .eq('job_id', sfJobId)
    .eq('is_paid', false)
    .eq('is_deleted', false)
    .order('date', { ascending: false })
    .limit(1)
  return (data?.[0] as { id: string } | undefined)?.id ?? null
}

/** Load + resolve a single unpaid invoice's contact/pay details from the mirror. */
export async function resolveInvoiceForResend(sfInvoiceId: string): Promise<ResendContext | null> {
  const supabase = db()
  const { data: inv } = await supabase
    .from('sf_invoices')
    .select('id, job_id, number, total, raw_data')
    .eq('id', sfInvoiceId)
    .maybeSingle()
  if (!inv) return null
  const invoice = inv as Pick<InvoiceRow, 'id' | 'job_id' | 'number' | 'total' | 'raw_data'>

  let job: JobRow | null = null
  if (invoice.job_id) {
    const { data } = await supabase
      .from('sf_jobs')
      .select('id, source, due_total, customer_name, customer_id, contact_first_name, contact_last_name')
      .eq('id', invoice.job_id)
      .maybeSingle()
    job = (data as JobRow) ?? null
  }

  let cust: Record<string, unknown> = {}
  if (job?.customer_id) {
    const { data } = await supabase.from('sf_customers').select('raw_data').eq('id', job.customer_id).maybeSingle()
    cust = ((data as { raw_data?: Record<string, unknown> } | null)?.raw_data) ?? {}
  }

  const raw = invoice.raw_data ?? {}
  const email = (
    (raw['bill_to_email_id'] as string) || (cust['email'] as string) || ''
  ).trim().toLowerCase() || null
  const phone = toE164((raw['bill_to_phone_id'] as string) || (cust['phone'] as string) || null)
  const payUrlLong = (raw['pay_online_url'] as string) || null
  const payUrl = payUrlLong ? await ensureShortLink(payUrlLong) : null
  const greeting = greetingFirstName({
    firstName: job?.contact_first_name ?? (cust['first_name'] as string | null),
    lastName: job?.contact_last_name ?? (cust['last_name'] as string | null),
    customerName: job?.customer_name ?? null,
  })
  const amountDue = job?.due_total ?? invoice.total ?? 0

  return {
    sfInvoiceId: invoice.id,
    sfJobId: invoice.job_id,
    invoiceNumber: invoice.number,
    customerName: job?.customer_name ?? null,
    greetingName: greeting,
    source: job?.source ?? null,
    amountDue,
    email,
    phone,
    payUrl,
  }
}

/**
 * Which channels a manual resend of `stage` would actually use, given the
 * invoice's contact info. Same resolution as the automated engine: email is
 * primary; SMS is the fallback when there's no email (for an email stage), and
 * is sent alongside email when the stage explicitly includes SMS.
 */
function resolveResendChannels(stage: CadenceStage, ctx: ResendContext): ('email' | 'sms')[] {
  const wantsEmail = stage.channels.includes('email')
  const wantsSms = stage.channels.includes('sms')
  const smsFallback = wantsEmail && !wantsSms && !ctx.email
  const out: ('email' | 'sms')[] = []
  if (wantsEmail && ctx.email) out.push('email')
  if ((wantsSms || smsFallback) && ctx.phone && isDialpadConfigured()) out.push('sms')
  return out
}

export interface ResendStagePreview {
  index: number
  day: number
  channels: ('email' | 'sms')[]          // stage's configured channels
  willSend: ('email' | 'sms')[]          // channels that would actually fire
  optedOut: ('email' | 'sms')[]          // channels blocked by an opt-out
  email: { to: string; subject: string; body: string } | null
  sms: { to: string; body: string } | null
}

export interface ResendData {
  ok: boolean
  reason?: 'not_found' | 'no_cadence' | 'excluded'
  source?: string | null
  sfInvoiceId: string | null
  invoiceNumber: string | null
  customerName: string | null
  amountDue: number
  hasEmail: boolean
  hasPhone: boolean
  dialpadConfigured: boolean
  stages: ResendStagePreview[]
}

const normSource = (s: string) => s.trim().toLowerCase()

/** A job source that's excluded from reminders (3rd-party-paid) can't be resent. */
function isExcludedSource(settings: ReminderSettings, source: string | null): boolean {
  if (!source) return false
  const excluded = new Set(settings.excluded_sources.map(normSource))
  return excluded.has(normSource(source))
}

/** Build the full modal payload for a job's unpaid invoice: per-stage previews. */
export async function getResendData(sfJobId: string): Promise<ResendData> {
  const settings = await loadSettings()
  const empty = { sfInvoiceId: null, invoiceNumber: null, customerName: null, amountDue: 0, hasEmail: false, hasPhone: false, dialpadConfigured: isDialpadConfigured(), stages: [] }
  const sfInvoiceId = await pickUnpaidInvoiceId(sfJobId)
  if (!sfInvoiceId) return { ok: false, reason: 'not_found', ...empty }
  const ctx = await resolveInvoiceForResend(sfInvoiceId)
  if (!ctx) return { ok: false, reason: 'not_found', ...empty }
  const base = { sfInvoiceId, invoiceNumber: ctx.invoiceNumber, customerName: ctx.customerName, amountDue: ctx.amountDue, hasEmail: !!ctx.email, hasPhone: !!ctx.phone }
  if (isExcludedSource(settings, ctx.source)) {
    return { ok: false, reason: 'excluded', source: ctx.source, ...empty, ...base }
  }
  if (settings.cadence.length === 0) {
    return { ok: false, reason: 'no_cadence', ...empty, ...base }
  }

  // Opt-out lookup for this invoice's specific recipients only.
  const supabase = db()
  const { data: optRows } = await supabase.from('invoice_reminder_optouts').select('channel, value')
  const optSet = new Set((optRows ?? []).map(r => `${r.channel}|${(r.value as string).toLowerCase()}`))
  const isOptedOut = (channel: 'email' | 'sms', recipient: string | null) =>
    !!recipient && optSet.has(`${channel}|${recipient.toLowerCase()}`)

  const vars = templateVars(ctx)
  const stages: ResendStagePreview[] = settings.cadence.map((stage, index) => {
    const resolved = resolveResendChannels(stage, ctx)
    const optedOut = resolved.filter(c => isOptedOut(c, c === 'email' ? ctx.email : ctx.phone))
    const willSend = resolved.filter(c => !optedOut.includes(c))
    return {
      index,
      day: stage.day,
      channels: stage.channels,
      willSend,
      optedOut,
      email: resolved.includes('email') && ctx.email
        ? { to: ctx.email, subject: renderTemplate(stage.email_subject, vars), body: renderTemplate(stage.email_body, vars) }
        : null,
      sms: resolved.includes('sms') && ctx.phone
        ? { to: ctx.phone, body: renderTemplate(stage.sms_body, vars) }
        : null,
    }
  })

  return {
    ok: true,
    sfInvoiceId,
    invoiceNumber: ctx.invoiceNumber,
    customerName: ctx.customerName,
    amountDue: ctx.amountDue,
    hasEmail: !!ctx.email,
    hasPhone: !!ctx.phone,
    dialpadConfigured: isDialpadConfigured(),
    stages,
  }
}

export interface ResendResult {
  ok: boolean
  reason?: 'not_found' | 'no_stage' | 'paid' | 'no_channels' | 'excluded'
  sent: ('email' | 'sms')[]
  failed: { channel: 'email' | 'sms'; error: string }[]
}

/** Send the chosen stage of the series to one invoice, right now. */
export async function manualResend(sfInvoiceId: string, stageIndex: number): Promise<ResendResult> {
  const settings = await loadSettings()
  const stage = settings.cadence[stageIndex]
  if (!stage) return { ok: false, reason: 'no_stage', sent: [], failed: [] }

  const ctx = await resolveInvoiceForResend(sfInvoiceId)
  if (!ctx) return { ok: false, reason: 'not_found', sent: [], failed: [] }

  // Excluded (3rd-party-paid) sources are never reminded — including manually.
  if (isExcludedSource(settings, ctx.source)) return { ok: false, reason: 'excluded', sent: [], failed: [] }

  // Never resend on an invoice that's already been paid (live SF re-check).
  if (!(await stillUnpaid(sfInvoiceId))) return { ok: false, reason: 'paid', sent: [], failed: [] }

  const supabase = db()
  const { data: optRows } = await supabase.from('invoice_reminder_optouts').select('channel, value')
  const optSet = new Set((optRows ?? []).map(r => `${r.channel}|${(r.value as string).toLowerCase()}`))

  const channels = resolveResendChannels(stage, ctx).filter(c => {
    const recipient = c === 'email' ? ctx.email : ctx.phone
    return !!recipient && !optSet.has(`${c}|${recipient.toLowerCase()}`)
  })
  if (channels.length === 0) return { ok: false, reason: 'no_channels', sent: [], failed: [] }

  const sent: ('email' | 'sms')[] = []
  const failed: { channel: 'email' | 'sms'; error: string }[] = []
  for (const channel of channels) {
    const recipient = (channel === 'email' ? ctx.email : ctx.phone) as string
    const p: PlannedSend = {
      sfInvoiceId: ctx.sfInvoiceId,
      sfJobId: ctx.sfJobId,
      invoiceNumber: ctx.invoiceNumber,
      customerName: ctx.customerName,
      greetingName: ctx.greetingName,
      source: null,
      stageIndex,
      stageDay: stage.day,
      channel,
      recipient,
      amountDue: ctx.amountDue,
      payUrl: ctx.payUrl,
    }
    const res = await deliverReminder(p, stage, settings, { manual: true })
    if (res.ok) sent.push(channel)
    else failed.push({ channel, error: res.error ?? 'failed' })
  }

  return { ok: sent.length > 0, sent, failed }
}
