import { describe, it, expect } from 'vitest'
import { reminderCandidates, csatWindow, type SurveyForReminder } from '@/lib/csat/reminders'
import { CSAT_DEFAULTS } from '@/lib/csat/config'

const now = new Date('2026-09-16T17:00:00Z')
const ago = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString()
const survey = (over: Partial<SurveyForReminder> = {}): SurveyForReminder => ({
  id: 's1', status: 'sent', is_test: false, phone_e164: '+17605551234', sent_at: ago(50),
  survey_reminder_sent_at: null, review_requested_at: null, review_msg_status: null,
  review_link_clicked_at: null, review_reminder_sent_at: null, ...over,
})
const run = (s: SurveyForReminder, live: string[] = [], opt: string[] = []) =>
  reminderCandidates([s], now, 48, new Set(live), new Set(opt))

describe('reminderCandidates', () => {
  it('nudges a survey with no reply after the delay', () => {
    expect(run(survey())).toEqual([{ surveyId: 's1', reminder: 'survey' }])
  })
  it('waits until the delay has passed', () => {
    expect(run(survey({ sent_at: ago(40) }))).toEqual([])
  })
  it('never reminds twice, test surveys, opted-out or phoneless customers', () => {
    expect(run(survey({ survey_reminder_sent_at: ago(1) }))).toEqual([])
    expect(run(survey({ is_test: true }))).toEqual([])
    expect(run(survey(), [], ['+17605551234'])).toEqual([])
    expect(run(survey({ phone_e164: null }))).toEqual([])
  })
  it('skips a survey the customer answered', () => {
    expect(run(survey({ status: 'responded' }))).toEqual([])
  })
  it('skips one already waiting in the queue', () => {
    expect(run(survey(), ['s1:survey'])).toEqual([])
  })
  it('nudges for the review link only when it was sent, not tapped, and not reminded', () => {
    const responded = survey({ status: 'responded', review_msg_status: 'sent', review_requested_at: ago(49) })
    expect(run(responded)).toEqual([{ surveyId: 's1', reminder: 'review' }])
    expect(run({ ...responded, review_link_clicked_at: ago(10) })).toEqual([])
    expect(run({ ...responded, review_reminder_sent_at: ago(10) })).toEqual([])
    expect(run({ ...responded, review_msg_status: 'failed' })).toEqual([])
    expect(run({ ...responded, review_requested_at: ago(30) })).toEqual([])
    expect(run(responded, ['s1:review'])).toEqual([])
  })
})

describe('csatWindow', () => {
  it('maps the texting hours onto every weekday', () => {
    const w = csatWindow({ ...CSAT_DEFAULTS, send_start_hour_pt: 8, send_end_hour_pt: 19 })
    expect(w.mon).toEqual([480, 1140]); expect(w.sun).toEqual([480, 1140])
    expect(csatWindow({ ...CSAT_DEFAULTS, send_start_hour_pt: 19, send_end_hour_pt: 8 }).tue).toBeNull()
  })
})
