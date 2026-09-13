import type { Handlers } from './dispatcher'
import { sendReviewReply } from './reply-send'
import { sendGbpPost } from './post-send'
import { sendCsatReminder } from '@/lib/csat/reminders'

// What the dispatcher does with each queue kind.
export const DISPATCH_HANDLERS: Handlers = {
  review_reply: sendReviewReply,
  csat_reminder: sendCsatReminder,
  gbp_post: sendGbpPost,
}
