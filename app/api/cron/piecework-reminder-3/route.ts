import { NextRequest, NextResponse } from 'next/server'
import { enqueuePieceworkReminders } from '../piecework-reminder-1/route'
import { isPtHour } from '@/lib/cron/pt-gate'

// Mon 9 AM PT (early reminder, 2 days before deadline). Scheduled at both
// 16:00 and 17:00 UTC; the PT gate runs it only on the 9 AM PT firing.
export const maxDuration = 60

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!isPtHour(9)) {
    return NextResponse.json({ ok: true, skipped: 'off-hour (pinned to 9 AM PT)' })
  }
  const enqueued = await enqueuePieceworkReminders()
  return NextResponse.json({ ok: true, enqueued })
}
