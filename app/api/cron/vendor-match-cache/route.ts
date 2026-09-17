import { NextRequest, NextResponse } from 'next/server'
import { refreshMatchCache } from '@/lib/vendor-orders/match-cache'

export const maxDuration = 300

// Keeps vendor_orders' cached SF job match current, so Action Items (and anything else that
// starts from an SF job) can join to the vendor order instead of re-running the matcher.
//
// Every 30 minutes through the working day. Jobs are created in Service Fusion all day long
// and a new one can match an order that had nothing before, so a nightly pass would leave
// the Unpaid tab's "Portal Complete?" wrong for most of a day. Overnight the cache cannot go
// stale — nobody is booking jobs — so the schedule stops rather than burning a full sf_jobs
// read every half hour for nothing. The HD Orders page also writes what it computes, so the
// rows anyone is actually looking at stay fresh between runs.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const started = Date.now()
  const result = await refreshMatchCache()
  return NextResponse.json({ ...result, ms: Date.now() - started, ok_run: true })
}
