import { NextRequest, NextResponse } from 'next/server'
import { getUnpaidJobs } from '@/lib/analytics/alerts'
import { buildArGroups, renderArEmail } from '@/lib/ar-aging/report'
import { enqueueForSubscribers } from '@/lib/notifications/enqueue'
import { isPtHour } from '@/lib/cron/pt-gate'

export const maxDuration = 120

// Weekly Accounts Receivable Aging Report — Monday 7 AM PT.
// Scheduled at both 14:00 and 15:00 UTC Monday; the PT gate runs it only on the
// 7 AM PT firing so it stays pinned to 7 AM across the PDT/PST switch. Sends
// three emails (Clopay, Genie, Remainder) to every subscriber of the
// 'weekly_ar_aging' notification type. Includes all unpaid jobs regardless of
// acquisition date.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isPtHour(7)) {
    return NextResponse.json({ ok: true, skipped: 'off-hour (pinned to 7 AM PT Monday)' })
  }
  const started = Date.now()

  // No row cap — a financial report must not silently truncate.
  const { items } = await getUnpaidJobs({ limit: null })
  const groups = buildArGroups(items)

  const results: Record<string, number> = {}
  for (const group of groups) {
    // Skip a category with no outstanding (>$0 due) jobs — don't send an empty
    // report. Every included job already has due_total > 0 (getUnpaidJobs), so
    // count === 0 means nothing is owed in this category this week.
    if (group.count === 0) {
      results[group.key] = 0
      continue
    }
    const { subject, html, text } = renderArEmail(group)
    results[group.key] = await enqueueForSubscribers({
      notificationTypeKey: 'weekly_ar_aging',
      subject,
      bodyHtml: html,
      bodyText: text,
    })
  }

  return NextResponse.json({
    ok: true,
    totalUnpaid: items.length,
    groups: groups.map(g => ({ key: g.key, count: g.count, totalDue: g.totalDue, queued: results[g.key] })),
    ms: Date.now() - started,
  })
}
