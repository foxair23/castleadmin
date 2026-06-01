import { NextRequest, NextResponse } from 'next/server'
import { runIncrementalSyncForEntity } from '@/lib/sf-mirror/sync-engine'

export const maxDuration = 300

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const started = Date.now()
  try {
    const upserted = await runIncrementalSyncForEntity('invoices')
    return NextResponse.json({ ok: true, invoices: upserted, ms: Date.now() - started })
  } catch (err) {
    console.error('[sf-sync-invoices] fatal:', err)
    return NextResponse.json({ ok: false, error: String(err), ms: Date.now() - started }, { status: 500 })
  }
}
