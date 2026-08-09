import { NextRequest, NextResponse } from 'next/server'
import { runGenieAutopilot } from '@/lib/vendor-orders/autopilot'

export const maxDuration = 300

// Autopilot: auto-create SF jobs for new Genie orders. No-ops unless autopilot is
// enabled in HD Orders. New-only + rate-capped in the engine.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const res = await runGenieAutopilot()
  return NextResponse.json(res)
}
