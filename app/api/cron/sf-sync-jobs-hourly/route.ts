import { NextRequest, NextResponse } from 'next/server'
import { runIncrementalSyncForEntity } from '@/lib/sf-mirror/sync-engine'

// Syncs SF jobs updated in the last 48h — runs every hour so the availability
// route always has fresh data for per-window capacity checks.
export const maxDuration = 120

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const started = Date.now()
  try {
    const upserted = await runIncrementalSyncForEntity('jobs')
    return NextResponse.json({ ok: true, upserted, ms: Date.now() - started })
  } catch (err) {
    console.error('[sf-sync-jobs-hourly] fatal:', err)
    return NextResponse.json({ ok: false, error: String(err), ms: Date.now() - started }, { status: 500 })
  }
}
