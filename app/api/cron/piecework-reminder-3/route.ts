import { NextRequest, NextResponse } from 'next/server'
import { enqueuePieceworkReminders } from '../piecework-reminder-1/route'

// Runs Mon 16:00 UTC = Mon ~8-9 AM PT (early reminder, 2 days before deadline)
export const maxDuration = 60

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const enqueued = await enqueuePieceworkReminders()
  return NextResponse.json({ ok: true, enqueued })
}
