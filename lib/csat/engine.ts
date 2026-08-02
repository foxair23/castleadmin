import type { SupabaseClient } from '@supabase/supabase-js'
import { sendSms, toE164, isDialpadConfigured } from '@/lib/dialpad/client'
import { ensureShortLink } from '@/lib/short-links'
import { enqueueForSubscribers } from '@/lib/notifications/enqueue'
import { sendEmail } from '@/lib/notifications/resend'
import { renderLowCsatAlert } from '@/lib/notifications/templates/low-csat-alert'
import { csatDb, loadCsatSettings, renderCsatTemplate, type CsatSettings } from './config'
import { parseRating, classify, isLow } from './parse'

// CSAT survey engine — schedule → send → handle reply. Reuses the Dialpad send
// path, the shared opt-out list, and the notification queue. Job completion is
// poll-derived (sf_jobs.work_completed_at, stamped by the hourly sync), so the
// effective survey latency floor is the sync cadence, not send_delay_minutes.

const CANCELLED = ['Cancelled', 'Void', 'Voided']
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://castleadmin.vercel.app'
const CSAT_URL = `${APP_URL}/admin/reviews?sub=csat`

// ── phone / attribution resolution ───────────────────────────────────────────

/** Best textable mobile for a customer: prefer a mobile-typed/primary contact
 *  phone, fall back to the customer's raw_data phone. Returns E.164 or null. */
async function pickCustomerPhone(db: SupabaseClient, customerId: string | null): Promise<string | null> {
  if (!customerId) return null
  // Contact phones (via the contact tree).
  const { data: contacts } = await db.from('sf_customer_contacts').select('id').eq('customer_id', customerId)
  const contactIds = (contacts ?? []).map(c => (c as { id: string }).id)
  if (contactIds.length) {
    const { data: phones } = await db
      .from('sf_contact_phones')
      .select('phone, type, is_primary')
      .in('contact_id', contactIds)
    const rows = (phones ?? []) as Array<{ phone: string | null; type: string | null; is_primary: boolean | null }>
    const mobileFirst = [...rows].sort((a, b) => {
      const am = /mob|cell/i.test(a.type ?? '') ? 0 : 1
      const bm = /mob|cell/i.test(b.type ?? '') ? 0 : 1
      if (am !== bm) return am - bm
      return (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0)
    })
    for (const r of mobileFirst) {
      const e = toE164(r.phone)
      if (e) return e
    }
  }
  // Fallback: flat raw_data phone on the customer.
  const { data: cust } = await db.from('sf_customers').select('raw_data').eq('id', customerId).maybeSingle()
  const raw = ((cust as { raw_data?: Record<string, unknown> } | null)?.raw_data) ?? {}
  return toE164((raw['phone'] as string) || (raw['mobile'] as string) || (raw['cell'] as string) || null)
}

/** Map the job's first assigned tech to an app user via commission_agent_map. */
async function resolvePrimaryTechUser(
  db: SupabaseClient,
  techs: Array<{ tech_id: string; name: string }>,
): Promise<string | null> {
  if (techs.length === 0) return null
  const { data: maps } = await db
    .from('commission_agent_map')
    .select('agent_id, agent_first_name, agent_last_name, tech_user_id')
  const rows = (maps ?? []) as Array<{ agent_id: string | null; agent_first_name: string | null; agent_last_name: string | null; tech_user_id: string }>
  const first = techs[0]
  const byId = rows.find(r => r.agent_id && r.agent_id === first.tech_id)
  if (byId) return byId.tech_user_id
  const nameKey = first.name.trim().toLowerCase()
  const byName = rows.find(r => `${r.agent_first_name ?? ''} ${r.agent_last_name ?? ''}`.trim().toLowerCase() === nameKey)
  return byName?.tech_user_id ?? null
}

// ── scheduling ───────────────────────────────────────────────────────────────

interface JobRow {
  id: string; number: string | null; customer_id: string | null; customer_name: string | null
  category: string | null; source: string | null; city: string | null; postal_code: string | null
  work_completed_at: string | null; status: string | null
}

/** Insert `scheduled` survey rows for newly-completed, eligible jobs. */
export async function scheduleEligibleSurveys(settings: CsatSettings): Promise<number> {
  const db = csatDb()
  const activated = settings.activated_at ?? new Date().toISOString()
  // Bound the scan: only jobs completed since activation and within the last 7d.
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const since = activated > weekAgo ? activated : weekAgo

  const { data: jobData } = await db
    .from('sf_jobs')
    .select('id, number, customer_id, customer_name, category, source, city, postal_code, work_completed_at, status')
    .not('work_completed_at', 'is', null)
    .gte('work_completed_at', since)
    .eq('is_deleted', false)
    .not('status', 'in', `(${CANCELLED.map(s => `"${s}"`).join(',')})`)
    .limit(2000)
  const jobs = (jobData ?? []) as JobRow[]
  if (jobs.length === 0) return 0

  // Skip jobs that already have a survey.
  const { data: existing } = await db.from('csat_surveys').select('sf_job_id').in('sf_job_id', jobs.map(j => j.id))
  const haveSurvey = new Set((existing ?? []).map(r => (r as { sf_job_id: string }).sf_job_id))

  const excludedCats = new Set(settings.excluded_job_categories.map(s => s.trim().toLowerCase()))
  const excludedSrcs = new Set(settings.excluded_sources.map(s => s.trim().toLowerCase()))

  let created = 0
  for (const job of jobs) {
    if (haveSurvey.has(job.id)) continue
    if (job.category && excludedCats.has(job.category.trim().toLowerCase())) continue
    if (job.source && excludedSrcs.has(job.source.trim().toLowerCase())) continue

    const phone = await pickCustomerPhone(db, job.customer_id)

    // Tech attribution snapshot.
    const { data: techRows } = await db
      .from('sf_job_techs').select('tech_id, tech_first_name, tech_last_name').eq('job_id', job.id)
    const techs = (techRows ?? []).map(t => {
      const r = t as { tech_id: string; tech_first_name: string | null; tech_last_name: string | null }
      return { tech_id: r.tech_id, name: [r.tech_first_name, r.tech_last_name].filter(Boolean).join(' ') }
    })
    const primaryTechUserId = await resolvePrimaryTechUser(db, techs)

    const completedAt = job.work_completed_at as string
    const scheduledSendAt = new Date(new Date(completedAt).getTime() + settings.send_delay_minutes * 60_000).toISOString()

    await db.from('csat_surveys').insert({
      sf_job_id: job.id,
      sf_customer_id: job.customer_id,
      customer_name: job.customer_name,
      phone_e164: phone,
      assigned_tech_ids: techs.map(t => t.tech_id),
      assigned_tech_names: techs.map(t => t.name).filter(Boolean),
      primary_tech_name: techs[0]?.name || null,
      primary_tech_user_id: primaryTechUserId,
      job_category: job.category,
      job_source: job.source,
      city: job.city,
      postal_code: job.postal_code,
      work_completed_at: completedAt,
      status: phone ? 'scheduled' : 'excluded',
      excluded_reason: phone ? null : 'no_phone',
      scheduled_send_at: scheduledSendAt,
    })
    created++
  }
  return created
}

// ── sending ──────────────────────────────────────────────────────────────────

/** Send the survey SMS for any scheduled survey now due, within texting hours. */
export async function runDueSurveys(settings: CsatSettings): Promise<{ sent: number; failed: number }> {
  const db = csatDb()
  if (!isDialpadConfigured()) return { sent: 0, failed: 0 }

  const { data: due } = await db
    .from('csat_surveys')
    .select('id, sf_job_id, phone_e164')
    .eq('status', 'scheduled')
    .not('phone_e164', 'is', null)
    .lte('scheduled_send_at', new Date().toISOString())
    .limit(200)
  const rows = (due ?? []) as Array<{ id: string; sf_job_id: string; phone_e164: string }>
  if (rows.length === 0) return { sent: 0, failed: 0 }

  // Shared SMS opt-out suppression.
  const { data: optRows } = await db.from('invoice_reminder_optouts').select('channel, value').eq('channel', 'sms')
  const optSet = new Set((optRows ?? []).map(r => (r.value as string).toLowerCase()))

  let sent = 0, failed = 0
  for (const s of rows) {
    if (optSet.has(s.phone_e164.toLowerCase())) {
      await db.from('csat_surveys').update({ status: 'excluded', excluded_reason: 'opted_out', updated_at: new Date().toISOString() }).eq('id', s.id)
      continue
    }
    const res = await sendSms(s.phone_e164, settings.survey_sms)
    if (res.ok) {
      await db.from('csat_surveys').update({
        status: 'sent', sent_at: new Date().toISOString(), provider_message_id: res.messageId, updated_at: new Date().toISOString(),
      }).eq('id', s.id)
      sent++
    } else {
      // Dialpad may reject an opted-out number without a webhook — record it.
      if (res.error && /opt.?out|unsubscrib|\bstop\b|consent|blocked/i.test(res.error)) {
        await db.from('invoice_reminder_optouts').upsert({ channel: 'sms', value: s.phone_e164, reason: 'stop' }, { onConflict: 'channel,value' })
      }
      await db.from('csat_surveys').update({ status: 'failed', send_error: res.error ?? 'sms failed', updated_at: new Date().toISOString() }).eq('id', s.id)
      failed++
    }
  }
  return { sent, failed }
}

export interface CsatRunResult { enabled: boolean; scheduled: number; sent: number; failed: number }

/** Top-level cron entry: schedule newly-eligible jobs, then send anything due. */
export async function runCsatSurveys(): Promise<CsatRunResult> {
  const settings = await loadCsatSettings()
  if (!settings.enabled) return { enabled: false, scheduled: 0, sent: 0, failed: 0 }
  const scheduled = await scheduleEligibleSurveys(settings)
  const { sent, failed } = await runDueSurveys(settings)
  return { enabled: true, scheduled, sent, failed }
}

// ── inbound reply ─────────────────────────────────────────────────────────────

interface SurveyForReply {
  id: string; sf_job_id: string; customer_name: string | null; phone_e164: string | null
  primary_tech_name: string | null; job_category: string | null; work_completed_at: string | null
  status: string; feedback_pending: boolean; clarify_sent_at: string | null
}

/**
 * Handle an inbound SMS as a CSAT reply. Returns an action string when this
 * message belongs to a CSAT survey (so the webhook stops), or null to let other
 * handlers (leadgen) try. Claims the message only when a recent survey is
 * actually awaiting input, or when a valid rating arrives for a recent survey
 * (a rating change).
 */
export async function handleCsatReply(from: string, text: string, providerMsgId: string | null): Promise<string | null> {
  const db = csatDb()
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { data } = await db
    .from('csat_surveys')
    .select('id, sf_job_id, customer_name, phone_e164, primary_tech_name, job_category, work_completed_at, status, feedback_pending, clarify_sent_at')
    .eq('phone_e164', from)
    .gte('sent_at', since)
    .order('sent_at', { ascending: false })
    .limit(1)
  const survey = (data?.[0] as SurveyForReply | undefined)
  if (!survey) return null

  const rating = parseRating(text)
  const awaitingRating = survey.status === 'sent'
  const awaitingFeedback = survey.feedback_pending
  const isRatingChange = survey.status === 'responded' && rating != null

  // Not our message: a finished survey that isn't awaiting anything and this
  // isn't a new rating → let leadgen handle it.
  if (!awaitingRating && !awaitingFeedback && !isRatingChange) return null

  // Idempotency: provider id, else a content hash bucketed to the minute.
  const dedupKey = providerMsgId
    ? `pid:${providerMsgId}`
    : `h:${survey.id}:${text.trim().toLowerCase()}:${new Date().toISOString().slice(0, 16)}`

  // A free-text reply after a 4 → store as feedback (no clarify).
  if (rating == null && awaitingFeedback) {
    await db.from('csat_responses')
      .update({ feedback_text: text.slice(0, 1000) })
      .eq('survey_id', survey.id).eq('is_current', true)
    await db.from('csat_surveys').update({ feedback_pending: false, updated_at: new Date().toISOString() }).eq('id', survey.id)
    return 'csat_feedback'
  }

  // Unparseable while awaiting a rating → one-time clarification.
  if (rating == null) {
    if (awaitingRating && !survey.clarify_sent_at) {
      const settings = await loadCsatSettings()
      await sendSms(from, settings.clarify_sms).catch(() => {})
      await db.from('csat_surveys').update({ clarify_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', survey.id)
      return 'csat_clarify'
    }
    return 'csat_noop'
  }

  // Valid rating. Record it (dedup guards duplicate webhooks), mark current.
  const classification = classify(rating)
  const { error: insErr } = await db.from('csat_responses').insert({
    survey_id: survey.id, sf_job_id: survey.sf_job_id, rating, classification,
    raw_message: text.slice(0, 1000), is_current: false, provider_message_id: providerMsgId, dedup_key: dedupKey,
  })
  if (insErr) return 'csat_duplicate' // unique(dedup_key) → already processed

  // Flip current pointer to this response.
  await db.from('csat_responses').update({ is_current: false }).eq('survey_id', survey.id)
  await db.from('csat_responses').update({ is_current: true }).eq('survey_id', survey.id).eq('dedup_key', dedupKey)
  await db.from('csat_surveys').update({ status: 'responded', feedback_pending: false, updated_at: new Date().toISOString() }).eq('id', survey.id)

  const settings = await loadCsatSettings()
  if (rating === 5) {
    const reviewUrl = await ensureShortLink(settings.google_review_url).catch(() => settings.google_review_url)
    const res = await sendSms(from, renderCsatTemplate(settings.thanks_5_sms, { review_url: reviewUrl })).catch(() => null)
    await db.from('csat_surveys').update({ review_requested_at: new Date().toISOString(), review_msg_status: res?.ok ? 'sent' : 'failed', updated_at: new Date().toISOString() }).eq('id', survey.id)
    return 'csat_rating_5'
  }
  if (rating === 4) {
    await sendSms(from, settings.ask_4_sms).catch(() => {})
    await db.from('csat_surveys').update({ feedback_pending: true, updated_at: new Date().toISOString() }).eq('id', survey.id)
    return 'csat_rating_4'
  }
  // Low (1–3): acknowledge, open a follow-up, alert admins.
  if (isLow(rating)) {
    await sendSms(from, settings.ack_low_sms).catch(() => {})
    await db.from('csat_follow_ups').upsert({ survey_id: survey.id, sf_job_id: survey.sf_job_id, rating, status: 'open' }, { onConflict: 'survey_id' })
    await alertLowScore(survey, rating, text.slice(0, 1000), settings)
    return 'csat_rating_low'
  }
  return 'csat_rating'
}

async function alertLowScore(survey: SurveyForReply, rating: number, feedback: string, settings: CsatSettings): Promise<void> {
  const { subject, bodyHtml, bodyText } = renderLowCsatAlert({
    customerName: survey.customer_name ?? 'Customer',
    score: rating,
    jobNumber: survey.sf_job_id,
    employeeName: survey.primary_tech_name,
    jobType: survey.job_category,
    completedAt: survey.work_completed_at,
    customerPhone: survey.phone_e164,
    feedback,
    caseUrl: CSAT_URL,
  })
  await enqueueForSubscribers({
    notificationTypeKey: 'low_csat_alert', subject, bodyHtml, bodyText,
    relatedEntityType: 'csat_survey', relatedEntityId: survey.id,
  }).catch(() => {})
  // Configured non-app-user recipients get the same email directly.
  for (const email of settings.alert_extra_recipient_emails) {
    await sendEmail({ to: email, subject, html: bodyHtml, text: bodyText }).catch(() => {})
  }
}
