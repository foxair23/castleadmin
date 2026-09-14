import { NextRequest, NextResponse } from 'next/server'
import { agentDb } from '@/lib/agent/settings'
import { isConfigured } from '@/lib/google-reviews/gbp-client'
import { syncPerformance } from '@/lib/google-reviews/performance'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Once a day: re-read the last 30 days of Google Business Profile performance
// (impressions, calls, website clicks, direction requests) and upsert. Google
// finalizes numbers a few days late, which is why the window overlaps.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isConfigured()) return NextResponse.json({ ok: true, skipped: 'google_not_configured' })
  const r = await syncPerformance(agentDb(), { days: 30 })
  return NextResponse.json(r)
}
