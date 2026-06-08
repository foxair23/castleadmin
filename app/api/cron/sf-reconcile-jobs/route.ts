import { NextRequest, NextResponse } from 'next/server'
import { runWeeklyReconcileForEntity } from '@/lib/sf-mirror/sync-engine'

// Reconcile all 618+ pages of jobs. We skip expand (no techs/payments/invoices child
// data) so each SF page comes back in ~500ms instead of ~3s, keeping the total well
// within the 800s limit. Child data stays fresh via the daily incremental sync.
export const maxDuration = 800

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const started = Date.now()
  try {
    const upserted = await runWeeklyReconcileForEntity('jobs', { skipExpand: true })
    return NextResponse.json({ ok: true, upserted, ms: Date.now() - started })
  } catch (err) {
    console.error('[sf-reconcile-jobs] fatal:', err)
    return NextResponse.json({ ok: false, error: String(err), ms: Date.now() - started }, { status: 500 })
  }
}
