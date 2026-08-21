import type { SupabaseClient } from '@supabase/supabase-js'
import { sendSms, toE164, isDialpadConfigured } from '@/lib/dialpad/client'
import { ensureShortLink } from '@/lib/short-links'
import { enqueueForSubscribers } from '@/lib/notifications/enqueue'
import { sendEmail } from '@/lib/notifications/resend'
import { renderLowCsatAlert } from '@/lib/notifications/templates/low-csat-alert'
import { syncSingleJob } from '@/lib/sf-mirror/sync-engine'
import { csatDb, loadCsatSettings, renderCsatTemplate, type CsatSettings } from './config'
import { parseRating, classify, isLow } from './parse'
import { aiExtractCsatCorrection } from './ai-extract'

// Resolve an open low-score follow-up (e.g. the customer corrected upward), and
// suppress its deferred alert so the detractor email never fires. alerted_at is
// stamped so dispatchLowScoreAlerts (which filters alerted_at is null) skips it.
async function resolveOpenFollowUp(db: SupabaseClient, surveyId: string, note: string): Promise<void> {
  const now = new Date().toISOString()
  await db.from('csat_follow_ups')
    .update({ status: 'resolved', resolved_at: now, alerted_at: now, notes: note })
    .eq('survey_id', surveyId).eq('status', 'open')
}

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

/**
 * Resolve a textable number, pulling the customer's contacts LIVE from Service
 * Fusion when the mirror has none. The hourly job sync mirrors the job but not
 * the customer's contact/phone records (those only refresh on backfill), so a
 * just-created customer's number is in SF but not yet copied locally.
 * syncSingleJob refreshes that job's customer contact tree, then we re-resolve.
 * Only fires the (heavier) SF pull when the mirror lookup comes up empty.
 */
async function resolvePhone(db: SupabaseClient, customerId: string | null, jobId: string): Promise<string | null> {
  const local = await pickCustomerPhone(db, customerId)
  if (local) return local
  try { await syncSingleJob(jobId) } catch { /* best-effort live pull */ }
  return pickCustomerPhone(db, customerId)
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

    // Pull the phone live from SF if the mirror doesn't have it yet (new-customer
    // contact lag). A miss here isn't fatal — the survey stays 'scheduled' and
    // runDueSurveys retries the pull for up to 2 days before giving up.
    const phone = await resolvePhone(db, job.customer_id, job.id)

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
      status: 'scheduled',              // stays retryable even without a phone yet
      excluded_reason: null,
      scheduled_send_at: scheduledSendAt,
    })
    created++
  }
  return created
}

// ── sending ──────────────────────────────────────────────────────────────────

// A survey with no phone yet keeps retrying the SF pull until this long after
// completion, then gives up as no_phone. The pull is throttled so a stuck survey
// doesn't hammer SF on every 15-minute run.
const PHONE_RETRY_MS = 2 * 86_400_000       // 2 days
const PHONE_RETRY_THROTTLE_MS = 3 * 3_600_000 // at most one live SF pull per 3h per survey

/** Send the survey SMS for any scheduled survey now due, within texting hours.
 *  A due survey missing its phone re-pulls it from SF (throttled), and is only
 *  settled as no_phone once the 2-day retry window has passed. */
export async function runDueSurveys(settings: CsatSettings): Promise<{ sent: number; failed: number }> {
  const db = csatDb()
  if (!isDialpadConfigured()) return { sent: 0, failed: 0 }

  const { data: due } = await db
    .from('csat_surveys')
    .select('id, sf_job_id, sf_customer_id, phone_e164, work_completed_at, updated_at')
    .eq('status', 'scheduled')
    .lte('scheduled_send_at', new Date().toISOString())
    .limit(200)
  const rows = (due ?? []) as Array<{
    id: string; sf_job_id: string; sf_customer_id: string | null
    phone_e164: string | null; work_completed_at: string | null; updated_at: string | null
  }>
  if (rows.length === 0) return { sent: 0, failed: 0 }

  // Shared SMS opt-out suppression.
  const { data: optRows } = await db.from('invoice_reminder_optouts').select('channel, value').eq('channel', 'sms')
  const optSet = new Set((optRows ?? []).map(r => (r.value as string).toLowerCase()))

  let sent = 0, failed = 0
  for (const s of rows) {
    let phone = s.phone_e164
    if (!phone) {
      // Retry the live pull, but no more than once per throttle window per survey.
      const lastTouch = s.updated_at ? new Date(s.updated_at).getTime() : 0
      if (Date.now() - lastTouch > PHONE_RETRY_THROTTLE_MS) {
        phone = await resolvePhone(db, s.sf_customer_id, s.sf_job_id)
        await db.from('csat_surveys').update({ phone_e164: phone, updated_at: new Date().toISOString() }).eq('id', s.id)
      }
      if (!phone) {
        // Give up only after the retry window elapses; otherwise wait for a later run.
        const completed = s.work_completed_at ? new Date(s.work_completed_at).getTime() : 0
        if (completed > 0 && Date.now() - completed > PHONE_RETRY_MS) {
          await db.from('csat_surveys').update({ status: 'excluded', excluded_reason: 'no_phone', updated_at: new Date().toISOString() }).eq('id', s.id)
        }
        continue
      }
    }

    if (optSet.has(phone.toLowerCase())) {
      await db.from('csat_surveys').update({ status: 'excluded', excluded_reason: 'opted_out', updated_at: new Date().toISOString() }).eq('id', s.id)
      continue
    }
    const res = await sendSms(phone, settings.survey_sms)
    if (res.ok) {
      await db.from('csat_surveys').update({
        status: 'sent', sent_at: new Date().toISOString(), provider_message_id: res.messageId, updated_at: new Date().toISOString(),
      }).eq('id', s.id)
      sent++
    } else {
      // Dialpad may reject an opted-out number without a webhook — record it.
      if (res.error && /opt.?out|unsubscrib|\bstop\b|consent|blocked/i.test(res.error)) {
        await db.from('invoice_reminder_optouts').upsert({ channel: 'sms', value: phone, reason: 'stop' }, { onConflict: 'channel,value' })
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

  // AI fallback (runs BEFORE the "not ours" guard so a correction after any
  // prior rating is caught, including after a 5 where nothing is pending): an
  // ambiguous natural-language reply ("I meant 5 not 1") that parseRating
  // rejects. Only a HIGH-confidence new 1–5 rating is applied. To stay safe on
  // the reputation path, an AI-inferred correction updates the SCORE but sends
  // NO customer SMS — the Google-review request in particular is held for office
  // confirmation (review_pending_confirm) when it lands on a 5.
  if (rating == null && survey.status === 'responded') {
    const { data: cur } = await db.from('csat_responses')
      .select('rating').eq('survey_id', survey.id).eq('is_current', true).maybeSingle()
    const priorRating = (cur?.rating as number | null) ?? null
    const ai = await aiExtractCsatCorrection(text, priorRating)
    if (ai && ai.confidence === 'high' && ai.correctedRating !== priorRating) {
      const nr = ai.correctedRating
      const dk = providerMsgId ? `pid:${providerMsgId}` : `ai:${survey.id}:${new Date().toISOString().slice(0, 16)}`
      const { error: aiErr } = await db.from('csat_responses').insert({
        survey_id: survey.id, sf_job_id: survey.sf_job_id, rating: nr, classification: classify(nr),
        raw_message: text.slice(0, 1000), is_current: false, provider_message_id: providerMsgId,
        dedup_key: dk, source: 'ai_correction',
      })
      if (aiErr) return 'csat_duplicate'
      await db.from('csat_responses').update({ is_current: false }).eq('survey_id', survey.id)
      await db.from('csat_responses').update({ is_current: true }).eq('survey_id', survey.id).eq('dedup_key', dk)
      const patch: Record<string, unknown> = { status: 'responded', feedback_pending: false, updated_at: new Date().toISOString() }
      // Upgraded out of the low range → cancel the pending detractor alert.
      if (!isLow(nr)) await resolveOpenFollowUp(db, survey.id, `auto-resolved: AI-detected correction to ${nr}`)
      // A 5 would normally trigger the Google-review text — hold it for the office.
      if (nr === 5) patch.review_pending_confirm = true
      await db.from('csat_surveys').update(patch).eq('id', survey.id)
      return 'csat_ai_correction'
    }
  }

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

  // Corrected up out of the low range → cancel any pending detractor alert so a
  // now-happy customer doesn't trigger a "low score" email (the screenshot case:
  // a "1" then "5" a minute later).
  if (!isLow(rating)) await resolveOpenFollowUp(db, survey.id, `auto-resolved: customer corrected to ${rating}`)

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
  // Low (1–3): acknowledge, open the feedback window (the ack asks what
  // happened), and open a follow-up whose alert is DEFERRED by
  // alert_delay_minutes. dispatchLowScoreAlerts (a cron) sends the internal
  // email once alert_after passes, so any detail the customer texts back in that
  // window is included. The live thread is also in Dialpad as a fallback.
  if (isLow(rating)) {
    await sendSms(from, settings.ack_low_sms).catch(() => {})
    await db.from('csat_surveys').update({ feedback_pending: true, updated_at: new Date().toISOString() }).eq('id', survey.id)
    const alertAfter = new Date(Date.now() + settings.alert_delay_minutes * 60_000).toISOString()
    await db.from('csat_follow_ups').upsert(
      { survey_id: survey.id, sf_job_id: survey.sf_job_id, rating, status: 'open', alert_after: alertAfter, alerted_at: null },
      { onConflict: 'survey_id' },
    )
    return 'csat_rating_low'
  }
  return 'csat_rating'
}

/**
 * Admin manually sets/corrects a survey's rating from the CSAT tab. Records a new
 * `csat_responses` row (source 'admin_edit', with edited_by) and repoints the
 * current pointer — same append-only "latest valid wins" model as inbound replies,
 * so the change is fully auditable. Never texts the customer. Cancels a pending
 * detractor alert when the score is corrected up out of the low range.
 */
export async function applyAdminRatingEdit(surveyId: string, newRating: number, editedBy: string): Promise<{ ok: boolean; error?: string }> {
  if (!Number.isInteger(newRating) || newRating < 1 || newRating > 5) return { ok: false, error: 'Rating must be 1–5.' }
  const db = csatDb()
  const { data: survey } = await db.from('csat_surveys').select('id, sf_job_id').eq('id', surveyId).maybeSingle()
  if (!survey) return { ok: false, error: 'Survey not found.' }

  const dk = `admin:${surveyId}:${new Date().toISOString()}`
  const { error: insErr } = await db.from('csat_responses').insert({
    survey_id: surveyId, sf_job_id: survey.sf_job_id, rating: newRating, classification: classify(newRating),
    raw_message: '(admin edit)', is_current: false, provider_message_id: null, dedup_key: dk,
    source: 'admin_edit', edited_by: editedBy,
  })
  if (insErr) return { ok: false, error: insErr.message }
  await db.from('csat_responses').update({ is_current: false }).eq('survey_id', surveyId)
  await db.from('csat_responses').update({ is_current: true }).eq('survey_id', surveyId).eq('dedup_key', dk)

  const patch: Record<string, unknown> = { status: 'responded', feedback_pending: false, updated_at: new Date().toISOString() }
  if (!isLow(newRating)) await resolveOpenFollowUp(db, surveyId, `auto-resolved: admin set rating to ${newRating}`)
  // A 5 makes the Google-review request available (office sends it explicitly).
  if (newRating === 5) patch.review_pending_confirm = true
  await db.from('csat_surveys').update(patch).eq('id', surveyId)
  return { ok: true }
}

/**
 * Send the (previously held) Google-review request for a 5-star survey — used by
 * the CSAT tab after the office confirms an AI-inferred or manually-set 5. Idempotent-ish:
 * only sends when the current rating is 5 and it hasn't been requested yet.
 */
export async function sendHeldReviewRequest(surveyId: string): Promise<{ ok: boolean; error?: string }> {
  const db = csatDb()
  const { data: survey } = await db.from('csat_surveys')
    .select('id, phone_e164, review_requested_at').eq('id', surveyId).maybeSingle()
  if (!survey) return { ok: false, error: 'Survey not found.' }
  if (survey.review_requested_at) return { ok: false, error: 'A review request was already sent.' }

  const { data: cur } = await db.from('csat_responses').select('rating').eq('survey_id', surveyId).eq('is_current', true).maybeSingle()
  if ((cur?.rating as number | null) !== 5) return { ok: false, error: 'Current rating is not 5.' }

  const settings = await loadCsatSettings()
  const reviewUrl = await ensureShortLink(settings.google_review_url).catch(() => settings.google_review_url)
  const res = await sendSms(survey.phone_e164, renderCsatTemplate(settings.thanks_5_sms, { review_url: reviewUrl })).catch(() => null)
  await db.from('csat_surveys').update({
    review_requested_at: new Date().toISOString(),
    review_msg_status: res?.ok ? 'sent' : 'failed',
    review_pending_confirm: false,
    updated_at: new Date().toISOString(),
  }).eq('id', surveyId)
  return res?.ok ? { ok: true } : { ok: false, error: 'SMS send failed.' }
}

// ── deferred low-score alert dispatch (cron) ──────────────────────────────────

/**
 * Send any low-score alerts whose delay window has elapsed. Rendered at dispatch
 * time so the customer's written detail (texted back after the ack) and full job
 * info are included. Not gated by the texting window — the team should hear about
 * an unhappy customer at any hour. Each row is claimed before sending so an
 * overlapping run can't double-alert.
 */
export async function dispatchLowScoreAlerts(): Promise<{ dispatched: number }> {
  const db = csatDb()
  const { data: due } = await db
    .from('csat_follow_ups')
    .select('id, survey_id, sf_job_id, rating')
    .is('alerted_at', null)
    .not('alert_after', 'is', null)
    .lte('alert_after', new Date().toISOString())
    .limit(100)
  const rows = (due ?? []) as Array<{ id: string; survey_id: string; sf_job_id: string; rating: number | null }>
  if (rows.length === 0) return { dispatched: 0 }

  const settings = await loadCsatSettings()
  let dispatched = 0
  for (const fu of rows) {
    // Claim (atomic-ish) so a concurrent run doesn't re-send this alert.
    const { data: claimed } = await db.from('csat_follow_ups')
      .update({ alerted_at: new Date().toISOString() }).eq('id', fu.id).is('alerted_at', null).select('id')
    if (!claimed || claimed.length === 0) continue

    const { data: survey } = await db.from('csat_surveys')
      .select('id, sf_job_id, customer_name, phone_e164, primary_tech_name, job_category, work_completed_at')
      .eq('id', fu.survey_id).maybeSingle()
    if (!survey) continue
    const s = survey as { id: string; sf_job_id: string; customer_name: string | null; phone_e164: string | null; primary_tech_name: string | null; job_category: string | null; work_completed_at: string | null }

    const { data: resp } = await db.from('csat_responses')
      .select('feedback_text, rating').eq('survey_id', fu.survey_id).eq('is_current', true).maybeSingle()
    const feedback = (resp as { feedback_text: string | null } | null)?.feedback_text ?? null

    const { data: job } = await db.from('sf_jobs')
      .select('number, street_1, street_2, city, state_prov, postal_code').eq('id', s.sf_job_id).maybeSingle()
    const j = job as { number: string | null; street_1: string | null; street_2: string | null; city: string | null; state_prov: string | null; postal_code: string | null } | null
    const address = j
      ? ([j.street_1, j.street_2, [j.city, j.state_prov, j.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null)
      : null

    const { subject, bodyHtml, bodyText } = renderLowCsatAlert({
      customerName: s.customer_name ?? 'Customer',
      score: fu.rating ?? (resp as { rating: number | null } | null)?.rating ?? 0,
      jobNumber: j?.number ?? s.sf_job_id,
      address,
      employeeName: s.primary_tech_name,
      jobType: s.job_category,
      completedAt: s.work_completed_at,
      customerPhone: s.phone_e164,
      feedback,
      caseUrl: CSAT_URL,
    })
    await enqueueForSubscribers({
      notificationTypeKey: 'low_csat_alert', subject, bodyHtml, bodyText,
      relatedEntityType: 'csat_survey', relatedEntityId: s.id,
    }).catch(() => {})
    for (const email of settings.alert_extra_recipient_emails) {
      await sendEmail({ to: email, subject, html: bodyHtml, text: bodyText }).catch(() => {})
    }
    dispatched++
  }
  return { dispatched }
}
