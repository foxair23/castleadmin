import { NextRequest, NextResponse } from 'next/server'
import { enqueuePieceworkReminders } from '../piecework-reminder-1/route'

// Runs Thu 01:00 UTC = Wed 6 PM PT (evening reminder on deadline day)
export const maxDuration = 60

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const enqueued = await enqueuePieceworkReminders()
  return NextResponse.json({ ok: true, enqueued })
}
