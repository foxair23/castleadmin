// Cassie escalation — a partner thread Cassie could not (or should not) answer has
// been handed to the team. Sent to subscribers of `cassie_escalation` plus any extra
// inboxes configured in Admin → Cassie → Settings. Same shape as the CSAT alert.

const BASE = `font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #111827; max-width: 560px; margin: 0 auto; padding: 32px 24px;`
const HEADING = `font-size: 20px; font-weight: 700; margin: 0 0 16px; color: #111827;`
const LABEL = `font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em;`
const VALUE = `font-size: 15px; margin: 2px 0 12px; white-space: pre-wrap;`
const MUTED = `font-size: 13px; color: #6b7280; margin: 24px 0 0;`

export interface CassieEscalationData {
  partnerName: string | null
  partnerEmail: string
  company: string
  subject: string
  question: string
  jobNumber: string | null
  matchNote: string
  reasons: string[]
  escalatedBy: string | null
  note: string | null
  reviewUrl: string
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function renderCassieEscalation(d: CassieEscalationData): { subject: string; bodyHtml: string; bodyText: string } {
  const who = d.partnerName ? `${d.partnerName} (${d.company})` : `${d.partnerEmail} (${d.company})`
  const subject = `Cassie needs a hand — ${d.company}: ${d.subject}`.slice(0, 140)
  const row = (label: string, value: string | null | undefined) => value ? `<p style="${LABEL}">${label}</p><p style="${VALUE}">${esc(value)}</p>` : ''
  const bodyHtml = `
<div style="${BASE}">
  <p style="${HEADING}">Cassie handed this thread to the team</p>
  ${row('From', `${who} <${d.partnerEmail}>`)}
  ${row('Subject', d.subject)}
  ${row('Their question', d.question)}
  ${row('Job', d.jobNumber ? `Job ${d.jobNumber}` : null)}
  ${row('Match', d.matchNote)}
  ${row('Why it was escalated', d.reasons.join('; '))}
  ${row('Note from ' + (d.escalatedBy ?? 'the reviewer'), d.note)}
  <p style="${MUTED}"><a href="${d.reviewUrl}" style="color:#111827;">Open in Castle Admin → Cassie → Review →</a></p>
  <p style="${MUTED}">Reply to the partner from the office inbox. Cassie will not reply in this thread.</p>
</div>`.trim()
  const bodyText = [
    'Cassie handed this thread to the team', '',
    `From: ${who} <${d.partnerEmail}>`, `Subject: ${d.subject}`, '', `Their question:`, d.question, '',
    ...(d.jobNumber ? [`Job: ${d.jobNumber}`] : []), `Match: ${d.matchNote}`, `Why: ${d.reasons.join('; ')}`,
    ...(d.note ? ['', `Note: ${d.note}`] : []), '',
    `Open: ${d.reviewUrl}`, 'Reply to the partner from the office inbox. Cassie will not reply in this thread.',
  ].join('\n')
  return { subject, bodyHtml, bodyText }
}
