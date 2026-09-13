import { NextRequest, NextResponse } from 'next/server'
import { runIngestPipeline } from '@/lib/google-reviews/ingest'

export const maxDuration = 300
export const dynamic = 'force-dynamic'

// Every 30 minutes: pull Google reviews, verify posted replies, match to jobs,
// tag, and draft replies for anything new. The admin "Sync & Match" button runs
// the same pipeline with a shorter budget.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const report = await runIngestPipeline({ trigger: 'cron', budgetMs: 250_000 })
    return NextResponse.json(report, { status: report.ok ? 200 : 500 })
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    console.error('[ingest-google-reviews] fatal:', m)
    return NextResponse.json({ ok: false, error: m }, { status: 500 })
  }
}
