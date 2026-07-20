import { NextRequest, NextResponse } from 'next/server'
import { enqueuePieceworkReminders } from '../piecework-reminder-1/route'
import { isPtHour } from '@/lib/cron/pt-gate'

// Wed 6 PM PT (evening reminder on deadline day). Scheduled at both 01:00 and
// 02:00 UTC Thursday (6 PM PT Wednesday falls on Thursday UTC in both PDT and
// PST); the PT gate runs it only on the 6 PM PT firing.
export const maxDuration = 60

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!isPtHour(18)) {
    return NextResponse.json({ ok: true, skipped: 'off-hour (pinned to 6 PM PT)' })
  }
  const enqueued = await enqueuePieceworkReminders()
  return NextResponse.json({ ok: true, enqueued })
}
