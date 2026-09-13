import { createClient } from '@supabase/supabase-js'

// CSAT settings loader — single row (id=1), mirrors lib/invoice-reminders
// loadSettings. Business config lives in the DB (admin-editable), not env vars.

export interface CsatSettings {
  enabled: boolean
  activated_at: string | null
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
  template_version: number
  /** 2-day reminders (PRD §3): hours after the survey / review link before the one follow-up. */
  reminder_delay_hours: number
  survey_reminder_sms: string
  review_reminder_sms: string
}

export const CSAT_DEFAULTS: CsatSettings = {
  enabled: false,
  activated_at: null,
  send_delay_minutes: 15,
  send_start_hour_pt: 8,
  send_end_hour_pt: 19,
  alert_delay_minutes: 5,
  excluded_job_categories: [],
  excluded_sources: [],
  google_review_url: 'https://g.page/r/CaHFdfDPyEDjEBE/review',
  survey_sms:
    'Castle Garage Doors: Thank you for your business! How satisfied were you with today\'s service?\n\nReply with a number from 1 to 5, where 5 means Very Satisfied and 1 means Very Dissatisfied.\n\nReply STOP to opt out.',
  thanks_5_sms:
    'We\'re glad you had a great experience! Would you be willing to share your experience in a Google review? Click here: {{review_url}}\n\nYour feedback means a lot to our family-owned business. We appreciate you!',
  ask_4_sms: 'Thank you for the feedback. We\'re always looking for ways to serve you better. What could we have done to make your experience a 5?',
  ack_low_sms:
    'Thank you for letting us know. We\'re sorry your experience did not meet expectations.\n\nCould you share a little more about what happened? A member of our team will also reach out so we can better understand the issue and help.',
  clarify_sms: 'Thanks! Please reply with one number from 1 to 5, where 5 means Very Satisfied and 1 means Very Dissatisfied.',
  alert_extra_recipient_emails: [],
  template_version: 1,
  reminder_delay_hours: 48,
  survey_reminder_sms:
    'Castle Garage Doors: Just checking in — how satisfied were you with your recent service? Reply with a number from 1 to 5 (5 = Very Satisfied). Reply STOP to opt out.',
  review_reminder_sms:
    'Thanks again for choosing Castle! If you have a minute, a quick Google review helps our family-owned business a lot: {{review_url}}',
}

export function csatDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

export async function loadCsatSettings(): Promise<CsatSettings> {
  const { data } = await csatDb().from('csat_settings').select('*').eq('id', 1).maybeSingle()
  const s = (data ?? {}) as Partial<CsatSettings>
  return {
    enabled: s.enabled ?? CSAT_DEFAULTS.enabled,
    activated_at: s.activated_at ?? null,
    send_delay_minutes: s.send_delay_minutes ?? CSAT_DEFAULTS.send_delay_minutes,
    send_start_hour_pt: s.send_start_hour_pt ?? CSAT_DEFAULTS.send_start_hour_pt,
    send_end_hour_pt: s.send_end_hour_pt ?? CSAT_DEFAULTS.send_end_hour_pt,
    alert_delay_minutes: s.alert_delay_minutes ?? CSAT_DEFAULTS.alert_delay_minutes,
    excluded_job_categories: s.excluded_job_categories ?? [],
    excluded_sources: s.excluded_sources ?? [],
    google_review_url: s.google_review_url ?? CSAT_DEFAULTS.google_review_url,
    survey_sms: s.survey_sms ?? CSAT_DEFAULTS.survey_sms,
    thanks_5_sms: s.thanks_5_sms ?? CSAT_DEFAULTS.thanks_5_sms,
    ask_4_sms: s.ask_4_sms ?? CSAT_DEFAULTS.ask_4_sms,
    ack_low_sms: s.ack_low_sms ?? CSAT_DEFAULTS.ack_low_sms,
    clarify_sms: s.clarify_sms ?? CSAT_DEFAULTS.clarify_sms,
    alert_extra_recipient_emails: s.alert_extra_recipient_emails ?? [],
    template_version: s.template_version ?? 1,
    reminder_delay_hours: s.reminder_delay_hours ?? CSAT_DEFAULTS.reminder_delay_hours,
    survey_reminder_sms: s.survey_reminder_sms ?? CSAT_DEFAULTS.survey_reminder_sms,
    review_reminder_sms: s.review_reminder_sms ?? CSAT_DEFAULTS.review_reminder_sms,
  }
}

/** Replace {{var}} placeholders (same syntax as the invoice-reminder engine). */
export function renderCsatTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? '')
}
