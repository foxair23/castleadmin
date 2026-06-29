import { NextRequest, NextResponse } from 'next/server'
import { runWeeklyReconcileForEntity, runScopedReconcile } from '@/lib/sf-mirror/sync-engine'
import { refreshCommission } from '@/lib/commission/engine'

// Reconcile all SF jobs. Two optimizations to fit within 800s:
//   skipExpand: omit child data (techs/payments/invoices) — kept fresh by daily sync
//   concurrency=3: fetch 3 pages in parallel, ~410s for 618 pages vs ~1550s sequential
export const maxDuration = 800

// The full reconcile above skips the agents expand for speed, so on Sunday
// (when the daily Mon–Sat scoped reconcile doesn't run) agent changes would be
// missed. Re-pull recent jobs WITH agents so agent edits are caught Sundays too.
const AGENT_RECONCILE_DAYS = 120

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const started = Date.now()
  try {
    const upserted = await runWeeklyReconcileForEntity('jobs', { skipExpand: true, concurrency: 3 })
    // Pick up agent changes on recent jobs, then recompute commission.
    let reconciled: unknown = null
    try {
      reconciled = await runScopedReconcile(AGENT_RECONCILE_DAYS, ['jobs'])
      await refreshCommission()
    } catch (e) {
      console.error('[sf-reconcile-jobs] agent reconcile / commission failed:', e)
      reconciled = { error: String(e) }
    }
    return NextResponse.json({ ok: true, upserted, reconciled, ms: Date.now() - started })
  } catch (err) {
    console.error('[sf-reconcile-jobs] fatal:', err)
    return NextResponse.json({ ok: false, error: String(err), ms: Date.now() - started }, { status: 500 })
  }
}
