import { NextRequest, NextResponse } from 'next/server'
import { runHealthDigest } from '@/lib/ops/health-cron'
import { isPtHour } from '@/lib/cron/pt-gate'

export const maxDuration = 60

// 7am PT daily: one summary of automation health and yesterday's counts, whatever the
// colour. Scheduled at both candidate UTC hours; the PT gate keeps it at 7am year-round.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isPtHour(7) && req.nextUrl.searchParams.get('force') !== '1') return NextResponse.json({ ok: true, skipped: 'off-hour (pinned to 7 AM PT)' })
  const r = await runHealthDigest()
  return NextResponse.json({ ok: true, ...r })
}
