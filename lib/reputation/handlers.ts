import type { Handlers } from './dispatcher'
import { sendReviewReply } from './reply-send'
import { sendCsatReminder } from '@/lib/csat/reminders'

// What the dispatcher does with each queue kind. gbp_post lands in Phase 2;
// until then its rows fail with "not implemented" instead of sitting forever.
export const DISPATCH_HANDLERS: Handlers = {
  review_reply: sendReviewReply,
  csat_reminder: sendCsatReminder,
}
