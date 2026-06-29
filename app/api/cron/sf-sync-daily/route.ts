import { NextRequest, NextResponse } from 'next/server'
import { runReferenceSync, runIncrementalSyncForEntity, runScopedReconcile } from '@/lib/sf-mirror/sync-engine'
import { refreshCommission } from '@/lib/commission/engine'

export const maxDuration = 800

// Re-pull recent jobs WITH their agents every day. The incremental sync filters
// by SF's updated_date, which an agent-only edit may not bump — so without this,
// removing/changing a job's Agent in SF wouldn't propagate until the weekly run.
// The scoped reconcile fetches by start_date with the agents expand, so agent
// changes on recent jobs are caught daily. 120d comfortably covers commission-
// eligible jobs (program started 2026-06-01).
const RECONCILE_DAYS = 120

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
    // Re-pull recent jobs (with agents) so agent changes propagate daily.
    let reconciled: unknown = null
    try {
      reconciled = await runScopedReconcile(RECONCILE_DAYS, ['jobs'])
    } catch (e) {
      console.error('[sf-sync-daily] scoped reconcile failed:', e)
      reconciled = { error: String(e) }
    }
    // Recompute commission off the fresh job/agent/invoice data. Non-fatal:
    // a commission error must not fail the mirror sync.
    let commission: unknown = null
    try {
      commission = await refreshCommission()
    } catch (e) {
      console.error('[sf-sync-daily] commission refresh failed:', e)
      commission = { error: String(e) }
    }
    return NextResponse.json({ ok: true, reference: refCounts, jobs: jobsUpserted, reconciled, commission, ms: Date.now() - started })
  } catch (err) {
    console.error('[sf-sync-daily] fatal:', err)
    return NextResponse.json({ ok: false, error: String(err), ms: Date.now() - started }, { status: 500 })
  }
}
