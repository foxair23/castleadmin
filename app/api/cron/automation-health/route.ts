import { NextRequest, NextResponse } from 'next/server'
import { runHealthEvaluation } from '@/lib/ops/health-cron'
import { currentPtHour } from '@/lib/cron/pt-gate'

export const maxDuration = 60

// Every 30 minutes in business hours PT, plus the 6am check (so "nightly full crawl done"
// is judged after its window). Emails only on a condition turning red / staying red past
// the cooldown / recovering. `?force=1` evaluates regardless of the hour (manual probe).
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const hour = currentPtHour()
  const force = req.nextUrl.searchParams.get('force') === '1'
  if (!force && !(hour === 6 || (hour >= 7 && hour <= 19))) return NextResponse.json({ ok: true, skipped: `off-hours (PT ${hour})` })
  const r = await runHealthEvaluation()
  return NextResponse.json({ ok: true, ...r })
}
