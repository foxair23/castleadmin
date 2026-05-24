import { NextRequest, NextResponse } from 'next/server'
import { runReferenceSync, runWeeklyReconcile } from '@/lib/sf-mirror/sync-engine'

export const maxDuration = 800

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const started = Date.now()
  try {
    const [refCounts, reconcileCounts] = await Promise.all([
      runReferenceSync(),
      runWeeklyReconcile(),
    ])
    return NextResponse.json({ ok: true, reference: refCounts, reconcile: reconcileCounts, ms: Date.now() - started })
  } catch (err) {
    console.error('[sf-sync-weekly] fatal:', err)
    return NextResponse.json({ ok: false, error: String(err), ms: Date.now() - started }, { status: 500 })
  }
}
