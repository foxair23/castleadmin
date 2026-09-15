import { NextRequest, NextResponse } from 'next/server'
import { runClopayStsAutoRequest } from '@/lib/clopay-sts/dc-request'
import { runMilestoneNoteSweep } from '@/lib/vendor-orders/milestone-notes'

export const maxDuration = 120

// Clopay STS auto-request: email the DC once for each new STS order whose details
// haven't been requested yet. No-op unless the toggle is on; new-only + capped.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const autoRequest = await runClopayStsAutoRequest()
  // Catch-up pass: an STS order is received before its SF job exists, and a DC report can
  // name an order whose job is made later, so the notes are written when both are in hand.
  const notes = await runMilestoneNoteSweep()
  return NextResponse.json({ autoRequest, notes })
}
