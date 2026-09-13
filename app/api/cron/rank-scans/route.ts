import { NextRequest, NextResponse } from 'next/server'
import { agentDb } from '@/lib/agent/settings'
import { runWeeklyScans } from '@/lib/rank/scan'

export const maxDuration = 300
export const dynamic = 'force-dynamic'

// Weekly Map Pack scans. Runs hourly on Monday and Tuesday (UTC) and picks up
// every active monitor not yet scanned this week, so a long list finishes over
// a few runs without any run exceeding its time budget. Skipped when the
// provider is not configured or the switch is off. ?force=1 ignores the switch.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const report = await runWeeklyScans(agentDb(), { deadline: Date.now() + 270_000, force: req.nextUrl.searchParams.get('force') === '1' })
  return NextResponse.json({ ok: true, ...report })
}
