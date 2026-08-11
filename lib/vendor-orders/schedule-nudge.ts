import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { sendEmail } from '@/lib/notifications/resend'
import { sendSms, toE164, isDialpadConfigured } from '@/lib/dialpad/client'
import { ensureShortLink } from '@/lib/short-links'
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
  const shortUrl = await ensureShortLink(/^https?:\/\//i.test(s.scheduleUrl) ? s.scheduleUrl : `https://${s.scheduleUrl}`)

  let sent = 0, failed = 0
  const errors: string[] = []

  for (const o of eligible) {
    const channels: string[] = []
    try {
      const greetingName = greetingFirstName({ customerName: o.customer_name })

      // Email
      if (o.email) {
        const { subject, html, text } = renderGenieScheduleEmail({ greetingName, scheduleUrl: s.scheduleUrl! })
        await sendEmail({ to: o.email, subject, html, text })
        channels.push('email')
      }

      // SMS (skip if not configured or the number is opted out)
      const e164 = toE164(o.phone)
      if (e164 && isDialpadConfigured()) {
        const { data: opt } = await supabase.from('invoice_reminder_optouts')
          .select('value').eq('channel', 'sms').eq('value', e164).maybeSingle()
        if (!opt) {
          const res = await sendSms(e164, renderGenieScheduleSms(shortUrl))
          if (res.ok) channels.push('sms')
          else errors.push(`order ${o.external_id} sms: ${res.error ?? 'failed'}`)
        }
      }

      if (channels.length) {
        await supabase.from('vendor_orders').update({
          schedule_nudge_sent_at: new Date().toISOString(),
          schedule_nudge_channels: channels.join(','),
          updated_at: new Date().toISOString(),
        }).eq('id', o.id)
        await supabase.from('vendor_order_events').insert({
          order_id: o.id, event_type: 'schedule_nudge_sent', to_value: channels.join(','),
        })
        sent++
      } else {
        failed++
      }
    } catch (e) {
      failed++
      errors.push(`order ${o.external_id}: ${e instanceof Error ? e.message : String(e)}`)
    }
    await sleep(1200) // gentle pacing
  }

  return { enabled: true, sent, failed, remaining: Math.max(0, eligible.length - sent - failed), errors }
}
