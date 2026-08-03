import { NextRequest, NextResponse } from 'next/server'
import { dispatchLowScoreAlerts } from '@/lib/csat/engine'

export const maxDuration = 120

// Dispatch deferred low-score CSAT alerts (rating 1–3). Runs every few minutes,
// ALL hours — unlike the survey send, an unhappy-customer alert should reach the
// team at any time. The delay (csat_settings.alert_delay_minutes, default 5) lets
// the customer's texted-back detail be included in the email; the live thread is
// also in Dialpad. No enabled-gate: a pending alert from before the service was
// paused should still go out.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const result = await dispatchLowScoreAlerts()
  return NextResponse.json({ ok: true, ...result })
}
