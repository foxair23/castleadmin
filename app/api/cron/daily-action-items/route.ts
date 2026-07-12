import { NextRequest, NextResponse } from 'next/server'
import { enqueueForSubscribers } from '@/lib/notifications/enqueue'
import { adminDb, computeTodoDigest, dateLabelPT, renderTodoEmail } from '@/lib/action-items/digest'

export const maxDuration = 300

// Morning Action Items to-do digest (Mon–Sat 7am PT, after the morning SF
// syncs): everything that needs a first touch or a follow-up today.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const started = Date.now()

  const d = await computeTodoDigest(adminDb())
  if (d.totalNew === 0 && d.totalDue === 0) {
    return NextResponse.json({ ok: true, skipped: 'nothing to do', ms: Date.now() - started })
  }

  const dateLabel = dateLabelPT()
  const subject = `Action Items To-Do — ${dateLabel}: ${d.totalNew} need first action, ${d.totalDue} follow-up${d.totalDue === 1 ? '' : 's'} due`
  const { html, text } = renderTodoEmail(d, {
    heading: 'Today’s Action Items To-Do',
    subtitle: `${dateLabel} · ${d.totalNew} need a first action · ${d.totalDue} follow-up${d.totalDue === 1 ? '' : 's'} due`,
  })

  const queued = await enqueueForSubscribers({
    notificationTypeKey: 'daily_action_items_todo',
    subject,
    bodyHtml: html,
    bodyText: text,
  })

  return NextResponse.json({ ok: true, totalNew: d.totalNew, totalDue: d.totalDue, queued, ms: Date.now() - started })
}
