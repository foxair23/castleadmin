import type { OutboundKind, ReplyBand, ReplyOrigin } from './settings'

// Outbound queue priorities (PRD §4.5): new negative replies first, then new
// positive, then CSAT reminders, then profile posts, then backlog replies.
// The dispatcher orders due rows by priority then scheduled time.

export function priorityFor(kind: OutboundKind, band: ReplyBand | null, origin: ReplyOrigin | null): number {
  if (kind === 'review_reply') {
    if (origin === 'backlog') return 5
    return band === 'negative' ? 1 : 2
  }
  if (kind === 'csat_reminder') return 3
  return 4 // gbp_post
}
