'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

// Admin server actions for the CSAT sub-tab (Reviews → CSAT). Mirrors the
// invoice-reminders actions: assertAdmin → service-role write → revalidate.

async function assertAdmin(): Promise<string> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') redirect('/login')
  return user.id
}

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

/** Master on/off switch. Stamps activated_at on enable (fresh-start anchor). */
export async function setCsatEnabled(enabled: boolean) {
  const userId = await assertAdmin()
  const patch: Record<string, unknown> = { enabled, updated_at: new Date().toISOString(), updated_by: userId }
  if (enabled) patch.activated_at = new Date().toISOString()
  const { error } = await svc().from('csat_settings').update(patch).eq('id', 1)
  if (error) throw new Error(error.message)
  revalidatePath('/admin/reviews')
}

export interface CsatSettingsInput {
  send_delay_minutes: number
  send_start_hour_pt: number
  send_end_hour_pt: number
  alert_delay_minutes: number
  excluded_job_categories: string[]
  excluded_sources: string[]
  google_review_url: string
  survey_sms: string
  thanks_5_sms: string
  ask_4_sms: string
  ack_low_sms: string
  clarify_sms: string
  alert_extra_recipient_emails: string[]
}

export async function saveCsatSettings(input: CsatSettingsInput) {
  const userId = await assertAdmin()
  const clampHour = (n: number) => Math.min(23, Math.max(0, Math.round(n)))
  const { error } = await svc().from('csat_settings').update({
    send_delay_minutes: Math.max(0, Math.round(input.send_delay_minutes)),
    send_start_hour_pt: clampHour(input.send_start_hour_pt),
    send_end_hour_pt: clampHour(input.send_end_hour_pt),
    alert_delay_minutes: Math.max(0, Math.round(input.alert_delay_minutes)),
    excluded_job_categories: input.excluded_job_categories ?? [],
    excluded_sources: input.excluded_sources ?? [],
    google_review_url: input.google_review_url.trim(),
    survey_sms: input.survey_sms,
    thanks_5_sms: input.thanks_5_sms,
    ask_4_sms: input.ask_4_sms,
    ack_low_sms: input.ack_low_sms,
    clarify_sms: input.clarify_sms,
    alert_extra_recipient_emails: (input.alert_extra_recipient_emails ?? [])
      .map(e => e.trim().toLowerCase()).filter(Boolean),
    updated_at: new Date().toISOString(),
    updated_by: userId,
  }).eq('id', 1)
  if (error) throw new Error(error.message)
  revalidatePath('/admin/reviews')
}

/** Advance a low-score follow-up (acknowledge / resolve). */
export async function updateFollowUp(surveyId: string, status: 'acknowledged' | 'resolved', notes?: string) {
  const userId = await assertAdmin()
  const patch: Record<string, unknown> = { status }
  const now = new Date().toISOString()
  if (status === 'acknowledged') { patch.acknowledged_by = userId; patch.acknowledged_at = now }
  if (status === 'resolved') { patch.resolved_by = userId; patch.resolved_at = now }
  if (notes !== undefined) patch.notes = notes
  const { error } = await svc().from('csat_follow_ups').update(patch).eq('survey_id', surveyId)
  if (error) throw new Error(error.message)
  revalidatePath('/admin/reviews')
}

/** Correct the attributed tech for a survey (audit-friendly override). */
export async function setPrimaryTech(surveyId: string, techUserId: string | null, techName: string | null) {
  await assertAdmin()
  const { error } = await svc().from('csat_surveys')
    .update({ primary_tech_user_id: techUserId, primary_tech_name: techName, updated_at: new Date().toISOString() })
    .eq('id', surveyId)
  if (error) throw new Error(error.message)
  revalidatePath('/admin/reviews')
}
