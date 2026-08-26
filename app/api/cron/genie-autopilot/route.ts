import { NextRequest, NextResponse } from 'next/server'
import { runVendorAutopilot } from '@/lib/vendor-orders/autopilot'
import { runGenieScheduleNudge } from '@/lib/vendor-orders/schedule-nudge'

export const maxDuration = 300

// Vendor-order automation: (1) auto-create SF jobs for new Genie AND Clopay orders
// (each gated by its own autopilot toggle, new-only + rate-capped), then (2) send
// the one-time Genie "please schedule" nudge. All no-op unless their toggle is on.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const autopilot = await runVendorAutopilot('genie_thd')
  const clopayAutopilot = await runVendorAutopilot('clopay_hd')
  const nudge = await runGenieScheduleNudge()
  return NextResponse.json({ autopilot, clopayAutopilot, nudge })
}
