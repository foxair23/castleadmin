import { NextRequest, NextResponse } from 'next/server'
import { agentDb } from '@/lib/agent/settings'
import { enqueueRecentJobs } from '@/lib/reputation/photo-queue'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Hourly in office hours: queue finished jobs (allowed categories, last two days)
// whose pictures have not been pulled yet, so the extension fetches them the same
// day and the 6am post pass finds them the next morning.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const r = await enqueueRecentJobs(agentDb())
  return NextResponse.json({ ok: true, ...r })
}
