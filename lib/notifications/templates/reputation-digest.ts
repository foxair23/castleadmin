import { appUrl } from '@/lib/config/domains'
import { THEME_LABEL, type Insights } from '@/lib/reputation/insights'

// The Monday reputation email (PRD §5 item 9): last week's reviews, the survey
// funnel, replies waiting, posts published, the top theme, and photo quality.
// Plain and phone-friendly, one link to the Reviews tab.

const BASE = `font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #111827; max-width: 560px; margin: 0 auto; padding: 24px;`
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const pct = (n: number, d: number) => d ? `${Math.round(n / d * 100)}%` : '—'
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export interface DigestInput { thisWeek: Insights; lastWeek: Insights; weekLabel: string }

/** Pure: the sections of the digest as short lines, so the email and the tests share one source. */
export function digestLines(input: DigestInput): { headline: string; sections: Array<{ title: string; lines: string[] }> } {
  const { thisWeek: t, lastWeek: l, weekLabel } = input
  const delta = (a: number, b: number) => a === b ? 'same as the week before' : a > b ? `up from ${b}` : `down from ${b}`
  const avg = t.reviews.avg != null ? `${t.reviews.avg.toFixed(2)} average` : 'no rating yet'
  const headline = `${plural(t.reviews.count, 'new Google review')} (${delta(t.reviews.count, l.reviews.count)}), ${avg}`

  const reviews = [
    `${t.reviews.fives} five-star · ${t.reviews.byStar[4]} four · ${t.reviews.byStar[3]} three · ${t.reviews.byStar[2]} two · ${t.reviews.ones} one-star`,
    ...(t.reviews.removed ? [`${plural(t.reviews.removed, 'review')} removed by Google or the reviewer`] : []),
  ]
  const f = t.funnel.total
  const funnel = [
    `${plural(f.sent, 'survey text')} sent → ${f.responded} replied (${pct(f.responded, f.sent)}) → ${f.fives} gave a 5 (${pct(f.fives, f.responded)})`,
    `${f.linkSent} got the review link → ${f.clicked} tapped it (${pct(f.clicked, f.linkSent)}) → ${f.reviewed} posted a review we matched (${pct(f.reviewed, f.linkSent)})`,
    ...(f.surveyReminders + f.reviewReminders ? [`Reminders: ${f.surveyReminders} survey, ${f.reviewReminders} review-link`] : []),
  ]
  const r = t.replies
  const replies = [
    `${r.replied} of ${r.reviewsInWindow} answered · ${r.unreplied} still open (${r.waitingApproval} waiting for approval, ${r.scheduled} scheduled)`,
    r.timed ? `Median ${r.medianHours != null ? Math.round(r.medianHours) : '—'} h to answer · ${pct(r.within24h, r.timed)} within a day · ${pct(r.within48h, r.timed)} within two` : 'No timed replies yet',
    `${r.byAgent} drafted by the agent (${r.autopilot} on autopilot, ${r.editedBeforeApproval} edited first) · ${r.byHand} written by hand`,
  ]
  const top = t.themes.themes.filter(x => x.positive + x.negative > 0).slice(0, 3)
  const negTop = [...t.themes.themes].sort((a, b) => b.negative - a.negative).find(x => x.negative > 0)
  const themes = [
    top.length ? `Most mentioned: ${top.map(x => `${THEME_LABEL[x.theme] ?? x.theme} (${x.positive + x.negative})`).join(', ')}` : 'No tagged reviews this week',
    ...(negTop ? [`Most common complaint: ${THEME_LABEL[negTop.theme] ?? negTop.theme} (${negTop.negative})`] : []),
    ...(t.mentions.length ? [`Techs named by customers: ${t.mentions.slice(0, 5).map(m => `${m.name} ×${m.mentions}`).join(', ')}`] : []),
  ]
  const p = t.posts
  const posts = [
    `${plural(p.published, 'profile post')} published · ${p.drafted} drafted · ${p.waitingApproval} waiting for approval${p.failed ? ` · ${p.failed} failed` : ''}`,
  ]
  const ph = t.photos
  const photos = [
    ph.total.photos ? `${ph.total.photos} job photos pulled · average score ${ph.total.avgScore ?? '—'} · ${pct(ph.total.usable, ph.total.photos)} usable` : 'No job photos pulled this week',
    ...(ph.byTech.length ? [`Best photos: ${ph.byTech.slice(0, 3).map(x => `${x.tech} (${x.avgScore ?? '—'})`).join(', ')}`] : []),
    ...(ph.byTech.length > 1 ? [`Needs work: ${[...ph.byTech].reverse().slice(0, 2).map(x => `${x.tech} (${x.avgScore ?? '—'}${x.topReasons[0] ? `, ${x.topReasons[0].reason}` : ''})`).join('; ')}`] : []),
  ]
  return {
    headline: `${weekLabel}: ${headline}`,
    sections: [
      { title: 'Reviews', lines: reviews }, { title: 'Survey funnel', lines: funnel }, { title: 'Replies', lines: replies },
      { title: 'What customers said', lines: themes }, { title: 'Profile posts', lines: posts }, { title: 'Job photos', lines: photos },
    ],
  }
}

export function renderReputationDigest(input: DigestInput): { subject: string; bodyHtml: string; bodyText: string } {
  const { headline, sections } = digestLines(input)
  const t = input.thisWeek
  const dot = t.reviews.ones > 0 || t.replies.unreplied > 3 ? '🟡' : '🟢'
  const subject = `${dot} Reputation — ${headline}`
  const link = `${appUrl()}/admin/reviews?sub=insights`
  const bodyText = `${headline}\n\n${sections.map(s => `${s.title}\n${s.lines.map(l => `• ${l}`).join('\n')}`).join('\n\n')}\n\nInsights: ${link}`
  const bodyHtml = `<div style="${BASE}"><p style="font-size:18px;font-weight:700;margin:0 0 12px">${esc(headline)}</p>${sections.map(s => `<p style="font-size:14px;font-weight:600;margin:14px 0 4px">${esc(s.title)}</p><ul style="font-size:14px;line-height:1.5;margin:0;padding-left:18px">${s.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>`).join('')}<p style="font-size:14px;margin-top:16px"><a href="${link}" style="color:#dc2626">Open Insights →</a></p></div>`
  return { subject, bodyHtml, bodyText }
}
