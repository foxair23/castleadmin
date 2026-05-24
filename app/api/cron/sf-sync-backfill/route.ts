/**
 * Backfill route — called manually from the admin "SF Sync" screen or via
 * a one-time cron trigger. Processes one entity per invocation (or all if no
 * entity param), saving last_page so interrupted runs resume correctly.
 *
 * POST /api/cron/sf-sync-backfill          → backfill all entities
 * POST /api/cron/sf-sync-backfill?entity=jobs → backfill just jobs
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { runBackfill } from '@/lib/sf-mirror/sync-engine'

export const maxDuration = 800

export async function POST(req: NextRequest) {
  // Allow both CRON_SECRET (automated) and admin session (manual trigger)
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { data: p } = await supabase.from('profiles').select('role').eq('id', user.id).single()
    if (p?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const entity = req.nextUrl.searchParams.get('entity') ?? undefined
  const started = Date.now()

  try {
    const counts = await runBackfill(entity)
    return NextResponse.json({ ok: true, counts, ms: Date.now() - started })
  } catch (err) {
    console.error('[sf-sync-backfill] fatal:', err)
    return NextResponse.json({ ok: false, error: String(err), ms: Date.now() - started }, { status: 500 })
  }
}
