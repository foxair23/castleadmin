import { getUnpaidJobs } from '@/lib/analytics/alerts'
import { buildArGroups, renderArEmail } from './report'
import { enqueueForSubscribers, enqueueNotification } from '@/lib/notifications/enqueue'

// Shared AR-aging send: builds the three source-grouped reports from the
// current Unpaid Jobs data and enqueues each non-empty one. Used by BOTH the
// Monday cron and the manual "Email A/R Report" button, so the emails are
// always identical. onlyUserId sends just to that user (a spot-check that
// bypasses subscription); otherwise it goes to every weekly_ar_aging subscriber.

export interface ArSendGroupResult {
  key: string
  label: string
  count: number
  totalDue: number
  queued: number
}

export interface ArSendResult {
  totalUnpaid: number
  groups: ArSendGroupResult[]
  recipients: 'subscribers' | 'self'
}

export async function sendArAgingReports(opts?: { onlyUserId?: string }): Promise<ArSendResult> {
  // No row cap — a financial report must not silently truncate.
  const { items } = await getUnpaidJobs({ limit: null })
  const groups = buildArGroups(items)

  const out: ArSendGroupResult[] = []
  for (const group of groups) {
    // Skip a category with no outstanding (>$0 due) jobs — no empty report.
    if (group.count === 0) {
      out.push({ key: group.key, label: group.label, count: 0, totalDue: 0, queued: 0 })
      continue
    }
    const { subject, html, text } = renderArEmail(group)
    let queued = 0
    if (opts?.onlyUserId) {
      const ok = await enqueueNotification({
        notificationTypeKey: 'weekly_ar_aging',
        userId: opts.onlyUserId,
        subject, bodyHtml: html, bodyText: text,
      })
      queued = ok ? 1 : 0
    } else {
      queued = await enqueueForSubscribers({
        notificationTypeKey: 'weekly_ar_aging',
        subject, bodyHtml: html, bodyText: text,
      })
    }
    out.push({ key: group.key, label: group.label, count: group.count, totalDue: group.totalDue, queued })
  }

  return { totalUnpaid: items.length, groups: out, recipients: opts?.onlyUserId ? 'self' : 'subscribers' }
}
