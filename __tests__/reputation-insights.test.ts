import { describe, it, expect } from 'vitest'
import { summarizeFunnel, summarizeThemes, summarizeMentions, summarizeReplies, summarizePhotos, type FunnelSurveyRow, type TaggedReviewRow } from '@/lib/reputation/insights'
import { digestWeeks } from '@/lib/reputation/digest'
import { digestLines, renderReputationDigest } from '@/lib/notifications/templates/reputation-digest'
import type { Insights } from '@/lib/reputation/insights'

const survey = (o: Partial<FunnelSurveyRow>): FunnelSurveyRow => ({
  sf_job_id: 'j1', sent_at: '2026-09-01T17:00:00Z', status: 'sent', rating: null, review_requested_at: null, review_link_clicked_at: null,
  survey_reminder_sent_at: null, review_reminder_sent_at: null, primary_tech_name: 'Sam Rivera', ...o,
})

describe('summarizeFunnel', () => {
  it('steps surveys down to matched reviews, per tech', () => {
    const rows = [
      survey({ sf_job_id: 'a', rating: 5, review_requested_at: 'x', review_link_clicked_at: 'y' }),
      survey({ sf_job_id: 'b', rating: 4, status: 'responded' }),
      survey({ sf_job_id: 'c', primary_tech_name: 'Lee Park', survey_reminder_sent_at: 'z' }),
      survey({ sf_job_id: 'd', sent_at: null }), // never sent: ignored
    ]
    const f = summarizeFunnel(rows, new Set(['a']))
    expect(f.total).toEqual({ sent: 3, responded: 2, fives: 1, linkSent: 1, clicked: 1, reviewed: 1, surveyReminders: 1, reviewReminders: 0 })
    expect(f.byTech.map(t => [t.tech, t.sent])).toEqual([['Sam Rivera', 2], ['Lee Park', 1]])
  })
})

const review = (o: Partial<TaggedReviewRow>): TaggedReviewRow => ({
  id: 'r', star_rating: 5, comment: 'Great job, on time and clean.', created_at_google: '2026-09-02T00:00:00Z', ai_sentiment: 'positive',
  ai_themes: ['punctuality'], ai_mentioned_names: [], matched_job_id: null, reviewer_name: 'A B', ...o,
})

describe('summarizeThemes', () => {
  it('splits theme counts by band and keeps one quote per band', () => {
    const rows = [
      review({ id: '1', ai_themes: ['punctuality', 'cleanliness'] }),
      review({ id: '2', star_rating: 2, ai_themes: ['punctuality'], comment: 'Two hours late.' }),
      review({ id: '3', star_rating: 5, ai_themes: ['punctuality'], comment: 'Right on time again.' }),
      review({ id: '4', ai_sentiment: null, ai_themes: [] }),
    ]
    const out = summarizeThemes(rows)
    expect(out.tagged).toBe(3); expect(out.untagged).toBe(1)
    const p = out.themes.find(t => t.theme === 'punctuality')!
    expect(p.positive).toBe(2); expect(p.negative).toBe(1)
    expect(p.quotes.map(q => q.stars)).toEqual([5, 2])
    expect(out.themes[0].theme).toBe('punctuality')
    expect(out.themes.length).toBe(9) // every fixed theme is listed, zeros included
  })
})

describe('summarizeMentions', () => {
  it('counts names and checks them against the job techs by first name', () => {
    const rows = [
      review({ id: '1', ai_mentioned_names: ['Sam'], matched_job_id: 'j1' }),
      review({ id: '2', ai_mentioned_names: ['Sam Rivera'], matched_job_id: 'j2', star_rating: 4 }),
      review({ id: '3', ai_mentioned_names: ['sam'], matched_job_id: null }),
    ]
    const techs = new Map([['j1', ['Sam Rivera']], ['j2', ['Lee Park']]])
    const [m] = summarizeMentions(rows, techs)
    expect(m).toEqual({ name: 'Sam Rivera', mentions: 3, fives: 2, matchesCreditedTech: 1, mismatches: 1 })
  })
})

describe('summarizeReplies', () => {
  it('measures coverage, speed and who wrote the reply', () => {
    const reviews = [
      { id: 'a', created_at_google: '2026-09-01T00:00:00Z', reply_text: 'Thanks', reply_updated_at: '2026-09-01T10:00:00Z', reply_source: 'agent', deleted_at: null },
      { id: 'b', created_at_google: '2026-09-01T00:00:00Z', reply_text: 'Thanks', reply_updated_at: '2026-09-03T12:00:00Z', reply_source: 'manual', deleted_at: null },
      { id: 'c', created_at_google: '2026-09-02T00:00:00Z', reply_text: null, reply_updated_at: null, reply_source: null, deleted_at: null },
      { id: 'd', created_at_google: '2026-09-02T00:00:00Z', reply_text: null, reply_updated_at: null, reply_source: null, deleted_at: '2026-09-03T00:00:00Z' },
    ]
    const replies = [
      { google_review_id: 'a', status: 'verified', sent_at: '2026-09-01T06:00:00Z', approved_by: null, approved_at: '2026-09-01T01:00:00Z', draft_text: 'Thanks', final_text: 'Thanks' },
      { google_review_id: 'c', status: 'draft', sent_at: null, approved_by: null, approved_at: null, draft_text: 'x', final_text: null },
    ]
    const r = summarizeReplies(reviews, replies)
    expect(r.reviewsInWindow).toBe(3)
    expect(r.replied).toBe(2); expect(r.unreplied).toBe(1); expect(r.waitingApproval).toBe(1)
    expect(r.byAgent).toBe(1); expect(r.byHand).toBe(1); expect(r.autopilot).toBe(1); expect(r.editedBeforeApproval).toBe(0)
    expect(r.timed).toBe(2); expect(r.within24h).toBe(1); expect(r.within48h).toBe(1)
    expect(r.medianHours).toBe((6 + 60) / 2)
  })
})

describe('summarizePhotos', () => {
  it('rolls scores up per tech and lists why photos fell short', () => {
    const photos = [
      { sf_job_id: 'j1', score: 90, score_reasons: ['clear subject'], public_url: 'u', override_usable: null },
      { sf_job_id: 'j1', score: 40, score_reasons: ['blurry', 'clutter'], public_url: 'u', override_usable: null },
      { sf_job_id: 'j2', score: 50, score_reasons: ['dark'], public_url: 'u', override_usable: true },
      { sf_job_id: 'j3', score: null, score_reasons: [], public_url: null, override_usable: null },
    ]
    const techs = new Map([['j1', ['Sam Rivera']], ['j2', ['Sam Rivera', 'Lee Park']]])
    const out = summarizePhotos(photos, techs, 70)
    expect(out.total).toEqual({ photos: 4, scored: 3, avgScore: 60, usable: 2 })
    const sam = out.byTech.find(t => t.tech === 'Sam Rivera')!
    expect(sam.jobs).toBe(2); expect(sam.photos).toBe(3); expect(sam.avgScore).toBe(60); expect(sam.usable).toBe(2)
    expect(sam.topReasons).toEqual([{ reason: 'blurry', count: 1 }, { reason: 'clutter', count: 1 }])
    expect(out.byTech.find(t => t.tech === 'Unassigned')!.photos).toBe(1)
  })
})

describe('digestWeeks', () => {
  it('reports the Monday–Sunday week that just ended, in PT', () => {
    // Monday 2026-09-14 07:05 PT = 14:05 UTC (PDT)
    const w = digestWeeks(new Date('2026-09-14T14:05:00Z'))
    expect(w.key).toBe('2026-09-07')
    expect(w.thisWeek.fromIso).toBe('2026-09-07T07:00:00.000Z')
    expect(w.thisWeek.toIso).toBe('2026-09-14T07:00:00.000Z')
    expect(w.lastWeek.fromIso).toBe('2026-08-31T07:00:00.000Z')
    expect(w.weekLabel).toBe('Week of Sep 7–Sep 13')
  })
  it('run mid-week still reports the last full week', () => {
    expect(digestWeeks(new Date('2026-09-17T18:00:00Z')).key).toBe('2026-09-07')
    expect(digestWeeks(new Date('2026-09-13T18:00:00Z')).key).toBe('2026-08-31') // a Sunday
  })
})

function insights(over: Partial<Insights['reviews']> = {}, extra: Partial<Insights> = {}): Insights {
  return {
    window: { fromIso: 'a', toIso: 'b' },
    reviews: { count: 4, avg: 4.75, fives: 3, ones: 0, removed: 0, byStar: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 3 }, ...over },
    funnel: { total: { sent: 20, responded: 10, fives: 8, linkSent: 8, clicked: 4, reviewed: 3, surveyReminders: 2, reviewReminders: 1 }, byTech: [] },
    themes: { themes: [{ theme: 'punctuality', positive: 3, negative: 1, quotes: [] }, { theme: 'price_value', positive: 0, negative: 2, quotes: [] }], tagged: 4, untagged: 0 },
    mentions: [{ name: 'Sam', mentions: 2, fives: 2, matchesCreditedTech: 2, mismatches: 0 }],
    replies: { reviewsInWindow: 4, replied: 3, unreplied: 1, waitingApproval: 1, scheduled: 0, medianHours: 9.6, within24h: 3, within48h: 3, timed: 3, byAgent: 2, byHand: 1, preExisting: 0, autopilot: 1, editedBeforeApproval: 1 },
    photos: { byTech: [{ tech: 'Sam Rivera', jobs: 2, photos: 4, scored: 4, avgScore: 82, usable: 3, usableShare: 75, topReasons: [] }, { tech: 'Lee Park', jobs: 1, photos: 2, scored: 2, avgScore: 45, usable: 0, usableShare: 0, topReasons: [{ reason: 'blurry', count: 2 }] }], total: { photos: 6, scored: 6, avgScore: 70, usable: 3 } },
    posts: { published: 2, drafted: 3, waitingApproval: 1, skipped: 0, failed: 0 },
    ...extra,
  }
}

describe('reputation digest', () => {
  it('writes plain lines with week-over-week movement and the top complaint', () => {
    const d = digestLines({ thisWeek: insights(), lastWeek: insights({ count: 2 }), weekLabel: 'Week of Sep 7–Sep 13' })
    expect(d.headline).toBe('Week of Sep 7–Sep 13: 4 new Google reviews (up from 2), 4.75 average')
    const text = d.sections.flatMap(s => s.lines).join('\n')
    expect(text).toContain('20 survey texts sent → 10 replied (50%) → 8 gave a 5 (80%)')
    expect(text).toContain('Most common complaint: Price and value (2)')
    expect(text).toContain('Techs named by customers: Sam ×2')
    expect(text).toContain('Median 10 h to answer · 100% within a day')
    expect(text).toContain('Needs work: Lee Park (45, blurry)')
  })
  it('turns the subject amber on a one-star week and never leaks HTML', () => {
    const mail = renderReputationDigest({ thisWeek: insights({ ones: 1 }), lastWeek: insights(), weekLabel: 'W' })
    expect(mail.subject.startsWith('🟡')).toBe(true)
    expect(mail.bodyText).toContain('Insights: ')
    expect(mail.bodyHtml).toContain('sub=insights')
    expect(renderReputationDigest({ thisWeek: insights(), lastWeek: insights(), weekLabel: 'W' }).subject.startsWith('🟢')).toBe(true)
  })
})
