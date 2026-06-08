import { NextRequest, NextResponse } from 'next/server'
import { runWeeklyReconcileForEntity } from '@/lib/sf-mirror/sync-engine'

// Reconcile all SF jobs. Two optimizations to fit within 800s:
//   skipExpand: omit child data (techs/payments/invoices) — kept fresh by daily sync
//   concurrency=3: fetch 3 pages in parallel, ~410s for 618 pages vs ~1550s sequential
export const maxDuration = 800

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const started = Date.now()
  try {
    const upserted = await runWeeklyReconcileForEntity('jobs', { skipExpand: true, concurrency: 3 })
    return NextResponse.json({ ok: true, upserted, ms: Date.now() - started })
  } catch (err) {
    console.error('[sf-reconcile-jobs] fatal:', err)
    return NextResponse.json({ ok: false, error: String(err), ms: Date.now() - started }, { status: 500 })
  }
}
