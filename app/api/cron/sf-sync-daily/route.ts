import { NextRequest, NextResponse } from 'next/server'
import { runReferenceSync, runIncrementalSyncForEntity } from '@/lib/sf-mirror/sync-engine'
import { refreshCommission } from '@/lib/commission/engine'

export const maxDuration = 300

function authorized(req: NextRequest) {
  return req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
}

// Runs reference tables + jobs (jobs is date-filtered and fast)
export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const started = Date.now()
  try {
    const [refCounts, jobsUpserted] = await Promise.all([
      runReferenceSync(),
      runIncrementalSyncForEntity('jobs'),
    ])
    // Recompute commission off the fresh job/agent/invoice data. Non-fatal:
    // a commission error must not fail the mirror sync.
    let commission: unknown = null
    try {
      commission = await refreshCommission()
    } catch (e) {
      console.error('[sf-sync-daily] commission refresh failed:', e)
      commission = { error: String(e) }
    }
    return NextResponse.json({ ok: true, reference: refCounts, jobs: jobsUpserted, commission, ms: Date.now() - started })
  } catch (err) {
    console.error('[sf-sync-daily] fatal:', err)
    return NextResponse.json({ ok: false, error: String(err), ms: Date.now() - started }, { status: 500 })
  }
}
