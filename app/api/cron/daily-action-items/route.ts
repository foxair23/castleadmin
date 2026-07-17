import { NextRequest, NextResponse } from 'next/server'
import { enqueueForSubscribers } from '@/lib/notifications/enqueue'
import { adminDb, computeTodoDigest, computeYesterdaySynopsis, renderSynopsis, dateLabelPT, renderTodoEmail } from '@/lib/action-items/digest'
import { isPtHour } from '@/lib/cron/pt-gate'

export const maxDuration = 300

// Morning Action Items to-do digest (Mon–Sat 7am PT, after the morning SF
// syncs): everything that needs a first touch or a follow-up today, led by a
// synopsis of yesterday's progress (actioned / cleared in SF / added / net).
// Scheduled at both 14:00 and 15:00 UTC; the PT gate runs it only on the 7 AM
// PT firing so it stays pinned to 7 AM across the PDT/PST switch.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isPtHour(7)) {
    return NextResponse.json({ ok: true, skipped: 'off-hour (pinned to 7 AM PT)' })
  }
  const started = Date.now()

  const db = adminDb()
  const d = await computeTodoDigest(db)

  // Snapshot yesterday's-vs-today's backlog and build the morning synopsis.
  // Runs even when there's nothing left to do, so the snapshot chain stays
  // unbroken and an all-clear morning still celebrates yesterday's wins.
  const synopsis = await computeYesterdaySynopsis(db, d)
  const { introHtml, introText } = renderSynopsis(synopsis)

  if (d.totalNew === 0 && d.totalDue === 0) {
    return NextResponse.json({ ok: true, skipped: 'nothing to do', synopsis, ms: Date.now() - started })
  }

  const dateLabel = dateLabelPT()
  const subject = `Action Items To-Do — ${dateLabel}: ${d.totalNew} need first action, ${d.totalDue} follow-up${d.totalDue === 1 ? '' : 's'} due`
  const { html, text } = renderTodoEmail(d, {
    heading: 'Today’s Action Items To-Do',
    subtitle: `${dateLabel} · ${d.totalNew} need a first action · ${d.totalDue} follow-up${d.totalDue === 1 ? '' : 's'} due`,
    introHtml,
    introText,
  })

  const queued = await enqueueForSubscribers({
    notificationTypeKey: 'daily_action_items_todo',
    subject,
    bodyHtml: html,
    bodyText: text,
  })

  return NextResponse.json({ ok: true, totalNew: d.totalNew, totalDue: d.totalDue, queued, ms: Date.now() - started })
}
