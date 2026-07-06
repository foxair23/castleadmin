import { NextRequest, NextResponse } from 'next/server'
import { runWeeklyReconcileForEntity } from '@/lib/sf-mirror/sync-engine'

export const maxDuration = 800

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const started = Date.now()
  try {
    // concurrency=3: like the jobs reconcile, fetch pages in parallel so the
    // full invoice scan finishes inside 800s. Sequential runs were killed by
    // Vercel mid-pagination, so the mirror never held the newest invoices.
    const upserted = await runWeeklyReconcileForEntity('invoices', { concurrency: 3 })
    return NextResponse.json({ ok: true, upserted, ms: Date.now() - started })
  } catch (err) {
    console.error('[sf-reconcile-invoices] fatal:', err)
    return NextResponse.json({ ok: false, error: String(err), ms: Date.now() - started }, { status: 500 })
  }
}
