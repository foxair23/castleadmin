import { NextRequest, NextResponse } from 'next/server'
import { runScopedReconcile } from '@/lib/sf-mirror/sync-engine'

// Full job scan (618+ pages) exceeds any serverless time limit.
// Reconcile the last 365 days instead — covers all actionable items on the
// Action Items dashboard. Jobs older than 1 year that are deleted in SF will
// linger in the mirror as is_deleted=false, but they don't surface in any alert.
export const maxDuration = 800

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const started = Date.now()
  try {
    const counts = await runScopedReconcile(365, ['jobs'])
    return NextResponse.json({ ok: true, counts, ms: Date.now() - started })
  } catch (err) {
    console.error('[sf-reconcile-jobs] fatal:', err)
    return NextResponse.json({ ok: false, error: String(err), ms: Date.now() - started }, { status: 500 })
  }
}
