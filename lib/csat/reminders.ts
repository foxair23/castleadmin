import type { SupabaseClient } from '@supabase/supabase-js'
import { sendSms } from '@/lib/dialpad/client'
import type { HandlerResult, QueueRowLike } from '@/lib/reputation/dispatcher'
import { enqueueOutbound, findLiveQueueRow } from '@/lib/reputation/queue'
import { loadReputationSettings, type WorkingWindow } from '@/lib/reputation/settings'
import { csatDb, loadCsatSettings, renderCsatTemplate, type CsatSettings } from './config'
import { ensureReviewLink, reviewLinkUrlFor } from './review-link'

// CSAT 2-day reminders (PRD §3). One reminder at most in each of two situations:
//   • survey sent, no reply after the delay        → survey_reminder_sms
//   • rated 5, link sent, link not tapped after it → review_reminder_sms
// Reminders are queued through the reputation dispatcher so they go out at
// humanized times inside the CSAT texting window, and the eligibility rules are
// re-checked at send time (a customer who replied or tapped meanwhile is skipped).

export type ReminderKind = 'survey' | 'review'

export interface SurveyForReminder {
  id: string
  status: string
  is_test: boolean
  phone_e164: string | null
  sent_at: string | null
  survey_reminder_sent_at: string | null
  review_requested_at: string | null
  review_msg_status: string | null
  review_link_clicked_at: string | null
  review_reminder_sent_at: string | null
}

const H = 3_600_000

/** Pure: which surveys are due which reminder right now. */
export function reminderCandidates(
  surveys: SurveyForReminder[], now: Date, delayHours: number,
  liveQueued: Set<string> /* `${surveyId}:${kind}` */, optouts: Set<string> /* lowercase phones */,
): Array<{ surveyId: string; reminder: ReminderKind }> {
  const cutoff = now.getTime() - delayHours * H
  const out: Array<{ surveyId: string; reminder: ReminderKind }> = []
  for (const s of surveys) {
    if (s.is_test || !s.phone_e164 || optouts.has(s.phone_e164.toLowerCase())) continue
    if (surveyReminderDue(s, cutoff) && !liveQueued.has(`${s.id}:survey`)) out.push({ surveyId: s.id, reminder: 'survey' })
    if (reviewReminderDue(s, cutoff) && !liveQueued.has(`${s.id}:review`)) out.push({ surveyId: s.id, reminder: 'review' })
  }
  return out
}

export function surveyReminderDue(s: SurveyForReminder, cutoffMs: number): boolean {
  return s.status === 'sent' && !!s.sent_at && new Date(s.sent_at).getTime() <= cutoffMs && !s.survey_reminder_sent_at
}

export function reviewReminderDue(s: SurveyForReminder, cutoffMs: number): boolean {
  return s.review_msg_status === 'sent' && !!s.review_requested_at
    && new Date(s.review_requested_at).getTime() <= cutoffMs
    && !s.review_link_clicked_at && !s.review_reminder_sent_at
}

/** The CSAT texting window as a dispatcher window: every day, start–end PT hours. */
export function csatWindow(settings: CsatSettings): WorkingWindow {
  const w: [number, number] | null = settings.send_end_hour_pt > settings.send_start_hour_pt
    ? [settings.send_start_hour_pt * 60, settings.send_end_hour_pt * 60] : null
  return { mon: w, tue: w, wed: w, thu: w, fri: w, sat: w, sun: w }
}

const SELECT = 'id, status, is_test, phone_e164, sent_at, survey_reminder_sent_at, review_requested_at, review_msg_status, review_link_clicked_at, review_reminder_sent_at'

/** Queue every due reminder. Returns the number queued. Called from runCsatSurveys. */
export async function runReminderPass(settings: CsatSettings, now = new Date()): Promise<number> {
  const db = csatDb()
  const since = new Date(now.getTime() - 14 * 24 * H).toISOString()
  const [{ data: a }, { data: b }, { data: opt }, { data: live }] = await Promise.all([
    db.from('csat_surveys').select(SELECT).eq('status', 'sent').is('survey_reminder_sent_at', null).eq('is_test', false).gte('sent_at', since).limit(500),
    db.from('csat_surveys').select(SELECT).eq('review_msg_status', 'sent').is('review_reminder_sent_at', null).is('review_link_clicked_at', null).eq('is_test', false).gte('review_requested_at', since).limit(500),
    db.from('invoice_reminder_optouts').select('value').eq('channel', 'sms'),
    db.from('outbound_queue').select('ref_id, payload').eq('kind', 'csat_reminder').in('status', ['queued', 'sending']).limit(2000),
  ])
  const byId = new Map<string, SurveyForReminder>()
  for (const r of [...(a ?? []), ...(b ?? [])] as SurveyForReminder[]) byId.set(r.id, r)
  const optouts = new Set(((opt ?? []) as Array<{ value: string }>).map(o => o.value.toLowerCase()))
  const liveQueued = new Set(((live ?? []) as Array<{ ref_id: string; payload: { reminder?: string } }>).map(l => `${l.ref_id}:${l.payload?.reminder ?? ''}`))

  const due = reminderCandidates([...byId.values()], now, settings.reminder_delay_hours, liveQueued, optouts)
  if (!due.length) return 0
  const rep = await loadReputationSettings(db)
  const window = csatWindow(settings)
  let queued = 0
  for (const d of due) {
    const res = await enqueueOutbound(db, rep, { kind: 'csat_reminder', refId: d.surveyId, earliestAt: now, payload: { reminder: d.reminder }, window }, now)
    if (res.ok) queued++
  }
  return queued
}

/** Dispatcher handler: re-check eligibility, render, send, stamp. */
export async function sendCsatReminder(db: SupabaseClient, row: QueueRowLike): Promise<HandlerResult> {
  const reminder = (row.payload?.reminder as ReminderKind | undefined) ?? null
  if (reminder !== 'survey' && reminder !== 'review') return { ok: false, error: 'unknown reminder kind', retry: false, cancel: true }
  const { data } = await db.from('csat_surveys').select(SELECT).eq('id', row.ref_id).maybeSingle()
  const s = data as SurveyForReminder | null
  if (!s || !s.phone_e164) return { ok: false, error: 'survey or phone missing', retry: false, cancel: true }
  const stillDue = reminder === 'survey' ? surveyReminderDue(s, Number.MAX_SAFE_INTEGER) : reviewReminderDue(s, Number.MAX_SAFE_INTEGER)
  if (!stillDue) return { ok: false, error: 'no longer eligible (customer replied, tapped, or was already reminded)', retry: false, cancel: true }
  const { data: opt } = await db.from('invoice_reminder_optouts').select('value').eq('channel', 'sms').eq('value', s.phone_e164).maybeSingle()
  if (opt) return { ok: false, error: 'opted out', retry: false, cancel: true }

  const settings = await loadCsatSettings()
  let text = settings.survey_reminder_sms
  if (reminder === 'review') {
    const { data: linkRow } = await db.from('csat_surveys').select('review_short_code').eq('id', s.id).maybeSingle()
    const code = (linkRow as { review_short_code: string | null } | null)?.review_short_code
    const url = code ? reviewLinkUrlFor(code) : await ensureReviewLink(db, s.id).catch(() => settings.google_review_url)
    text = renderCsatTemplate(settings.review_reminder_sms, { review_url: url })
  }
  const res = await sendSms(s.phone_e164, text).catch(e => ({ ok: false as const, messageId: null, status: 0, error: e instanceof Error ? e.message : String(e) }))
  if (!res.ok) {
    if (res.error && /opt.?out|unsubscrib|\bstop\b|consent|blocked/i.test(res.error)) {
      await db.from('invoice_reminder_optouts').upsert({ channel: 'sms', value: s.phone_e164, reason: 'stop' }, { onConflict: 'channel,value' })
      return { ok: false, error: res.error, retry: false, cancel: true, optOut: true }
    }
    return { ok: false, error: res.error ?? 'sms failed', retry: true }
  }
  const stamp = reminder === 'survey' ? { survey_reminder_sent_at: new Date().toISOString() } : { review_reminder_sent_at: new Date().toISOString() }
  await db.from('csat_surveys').update({ ...stamp, updated_at: new Date().toISOString() }).eq('id', s.id)
  return { ok: true }
}

/** Queue rows the dispatcher already holds for a survey (used by the CSAT tab). */
export async function pendingReminder(db: SupabaseClient, surveyId: string, kind: ReminderKind) {
  return findLiveQueueRow(db, 'csat_reminder', surveyId, { reminder: kind })
}
