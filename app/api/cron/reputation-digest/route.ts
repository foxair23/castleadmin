import { NextRequest, NextResponse } from 'next/server'
import { runReputationDigest } from '@/lib/reputation/digest'
import { isPtHour } from '@/lib/cron/pt-gate'

export const maxDuration = 120

// Monday 7am PT: the weekly reputation digest. Scheduled at both candidate UTC
// hours; the PT gate keeps it at 7am year-round. ?force=1 sends it now.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isPtHour(7) && req.nextUrl.searchParams.get('force') !== '1') return NextResponse.json({ ok: true, skipped: 'off-hour (pinned to 7 AM PT)' })
  const r = await runReputationDigest()
  return NextResponse.json({ ok: true, ...r })
}
