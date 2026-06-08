import { NextRequest, NextResponse } from 'next/server'
import { runWeeklyReconcileForEntity } from '@/lib/sf-mirror/sync-engine'

export const maxDuration = 800

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const started = Date.now()
  try {
    const upserted = await runWeeklyReconcileForEntity('estimates')
    return NextResponse.json({ ok: true, upserted, ms: Date.now() - started })
  } catch (err) {
    console.error('[sf-reconcile-estimates] fatal:', err)
    return NextResponse.json({ ok: false, error: String(err), ms: Date.now() - started }, { status: 500 })
  }
}
