import { NextRequest, NextResponse } from 'next/server'
import { runGenieAutopilot } from '@/lib/vendor-orders/autopilot'
import { runGenieScheduleNudge } from '@/lib/vendor-orders/schedule-nudge'

export const maxDuration = 300

// Genie automation: (1) auto-create SF jobs for new orders, then (2) send the
// one-time "please schedule" nudge to customers whose job now exists. Both no-op
// unless their respective toggle is on; both are new-only + rate-capped.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const autopilot = await runGenieAutopilot()
  const nudge = await runGenieScheduleNudge()
  return NextResponse.json({ autopilot, nudge })
}
