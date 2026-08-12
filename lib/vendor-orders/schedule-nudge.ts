import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { sendEmail } from '@/lib/notifications/resend'
import { sendSms, toE164, isDialpadConfigured } from '@/lib/dialpad/client'
import { greetingFirstName } from '@/lib/names'
import { renderGenieScheduleEmail, renderGenieScheduleSms } from '@/lib/notifications/templates/genie-schedule-email'

// Genie schedule nudge: when ON, a cron sends a ONE-TIME email + SMS to the
// customer of each NEW Genie order that already has an SF job, pointing them at
// the self-scheduler. Mirrors the LeadGen outreach (sendLeadOutreach) and the
// autopilot's new-only cutoff. Strict guards so it never blasts the backlog or
// double-sends:
//   • only orders first seen AT/AFTER enabled_at (turning it on ignores history)
//   • only active orders (not Cancelled / Closed / Completed)
//   • only orders we've created an SF job for (sf_created_job_number not null),
//     so the scheduler can actually find their order
//   • not already scheduled (appointment_date null) and not already nudged
//   • honors the shared SMS opt-out list; STOP disclosure is in the SMS body

const VENDOR = 'genie_thd'
const SEND_CAP = 25            // max customers nudged per cron run
// Vanity short link used in the SMS (the email uses the full configured URL).
const SMS_SCHEDULE_LINK = 'http://gdo.cstle.co/'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

const isActive = (status: string | null) => {
  const s = (status || '').toLowerCase()
  return !s.startsWith('cancel') && !s.startsWith('clos') && !s.startsWith('complet')
}

export interface NudgeSettings { enabled: boolean; enabledAt: string | null; scheduleUrl: string | null }

export async function getNudgeSettings(vendor = VENDOR): Promise<NudgeSettings> {
  const { data } = await db().from('vendor_schedule_nudge').select('enabled, enabled_at, schedule_url').eq('vendor', vendor).maybeSingle()
  return { enabled: !!data?.enabled, enabledAt: data?.enabled_at ?? null, scheduleUrl: data?.schedule_url ?? null }
}

export async function setNudgeSettings(vendor: string, enabled: boolean, scheduleUrl: string | null, userId: string | null): Promise<void> {
  const patch: Record<string, unknown> = { vendor, enabled, schedule_url: scheduleUrl, updated_at: new Date().toISOString(), updated_by: userId }
  // Stamp the cutoff each time it's turned ON, so the backlog is never swept.
  if (enabled) patch.enabled_at = new Date().toISOString()
  await db().from('vendor_schedule_nudge').upsert(patch, { onConflict: 'vendor' })
}

export interface NudgeRunResult { enabled: boolean; sent: number; failed: number; remaining: number; errors: string[] }

/** Send the one-time schedule nudge to eligible new Genie orders. */
export async function runGenieScheduleNudge(): Promise<NudgeRunResult> {
  const s = await getNudgeSettings()
  if (!s.enabled || !s.enabledAt || !s.scheduleUrl) {
    return { enabled: false, sent: 0, failed: 0, remaining: 0, errors: [] }
  }
  const supabase = db()

  // Eligible: new (post-enable), active, has an SF job, has contact info, not yet
  // scheduled, not yet nudged. Fetch a small batch; final active check in JS.
  const { data: rows } = await supabase
    .from('vendor_orders')
    .select('id, external_id, customer_name, phone, email, status, first_seen_at')
    .eq('vendor', VENDOR)
    .not('sf_created_job_number', 'is', null)
    .not('detail_scraped_at', 'is', null)
    .is('appointment_date', null)
    .is('schedule_nudge_sent_at', null)
    .gte('first_seen_at', s.enabledAt)
    .order('first_seen_at', { ascending: true })
    .limit(SEND_CAP)

  const eligible = (rows ?? []).filter(o => isActive(o.status) && (o.email || o.phone))

  let sent = 0, failed = 0
  const errors: string[] = []

  for (const o of eligible) {
    try {
      const { channels, error } = await deliverNudge(supabase, o, s.scheduleUrl!)
      if (channels.length) sent++; else failed++
      if (error) errors.push(`order ${o.external_id}: ${error}`)
    } catch (e) {
      failed++
      errors.push(`order ${o.external_id}: ${e instanceof Error ? e.message : String(e)}`)
    }
    await sleep(1200) // gentle pacing
  }

  return { enabled: true, sent, failed, remaining: Math.max(0, eligible.length - sent - failed), errors }
}

interface NudgeOrder { id: string; external_id: string; customer_name: string | null; phone: string | null; email: string | null }

// Send the email + SMS for one order and stamp it. Shared by the cron sweep and
// the manual "Send reminder" button. A failed email doesn't block the SMS.
async function deliverNudge(supabase: SupabaseClient, o: NudgeOrder, scheduleUrl: string): Promise<{ channels: string[]; error?: string }> {
  const channels: string[] = []
  let error: string | undefined
  const greetingName = greetingFirstName({ customerName: o.customer_name })

  if (o.email) {
    try {
      const { subject, html, text } = renderGenieScheduleEmail({ greetingName, scheduleUrl })
      await sendEmail({ to: o.email, subject, html, text })
      channels.push('email')
    } catch (e) { error = `email: ${e instanceof Error ? e.message : String(e)}` }
  }

  const e164 = toE164(o.phone)
  if (e164 && isDialpadConfigured()) {
    const { data: opt } = await supabase.from('invoice_reminder_optouts').select('value').eq('channel', 'sms').eq('value', e164).maybeSingle()
    if (!opt) {
      const res = await sendSms(e164, renderGenieScheduleSms(SMS_SCHEDULE_LINK))
      if (res.ok) channels.push('sms')
      else error = `${error ? error + '; ' : ''}sms: ${res.error ?? 'failed'}`
    }
  }

  if (channels.length) {
    const now = new Date().toISOString()
    await supabase.from('vendor_orders').update({ schedule_nudge_sent_at: now, schedule_nudge_channels: channels.join(','), updated_at: now }).eq('id', o.id)
    await supabase.from('vendor_order_events').insert({ order_id: o.id, event_type: 'schedule_nudge_sent', to_value: channels.join(',') })
  }
  return { channels, error }
}

// Manual "Send reminder now" for one order (HD Orders button). Bypasses the
// new-only cutoff and the send-once gate (an explicit resend is allowed), but
// still requires an SF job (so the scheduler can find them) + contact info, and
// honors the SMS opt-out list. Only needs the scheduler URL configured — works
// even when the automatic nudge toggle is off.
export async function sendNudgeForOrder(orderId: string): Promise<{ ok: boolean; channels?: string[]; error?: string; warning?: string }> {
  const s = await getNudgeSettings()
  if (!s.scheduleUrl) return { ok: false, error: 'Set the scheduler page URL in HD Orders first.' }
  const supabase = db()
  const { data: o } = await supabase
    .from('vendor_orders')
    .select('id, external_id, customer_name, phone, email, status, sf_created_job_number, sf_job_id, appointment_date')
    .eq('id', orderId)
    .single()
  if (!o) return { ok: false, error: 'Order not found.' }
  if (!o.sf_created_job_number && !o.sf_job_id) return { ok: false, error: 'No SF job yet — create it first so the scheduler can find the customer.' }
  if (!o.email && !o.phone) return { ok: false, error: 'No phone or email on this order.' }
  try {
    const { channels, error } = await deliverNudge(supabase, o, s.scheduleUrl)
    if (!channels.length) return { ok: false, error: error ?? 'Nothing sent (opted out / no reachable channel).' }
    const parts: string[] = []
    if (o.appointment_date) parts.push('note: customer already has an appointment')
    if (error) parts.push(error)
    return { ok: true, channels, warning: parts.length ? parts.join('; ') : undefined }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
