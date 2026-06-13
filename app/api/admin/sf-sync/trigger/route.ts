import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  runReferenceSync,
  runIncrementalSync,
  runIncrementalSyncForEntity,
  runWeeklyReconcile,
  runWeeklyReconcileForEntity,
  runScopedReconcile,
  runBackfill,
  reprocessCustomerChildren,
} from '@/lib/sf-mirror/sync-engine'

export const maxDuration = 300

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const adminClient = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
  const { data: profile } = await adminClient
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (profile?.role !== 'admin') return null
  return user
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin()
  if (!admin) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const t0 = Date.now()

  try {
    const body = await req.json()
    const { action, entity } = body as {
      action: string; entity?: string; days?: number; entities?: string[]
      skipExpand?: boolean; concurrency?: number
    }

    let counts: Record<string, number>

    if (action === 'sync-entity') {
      if (!entity) return NextResponse.json({ ok: false, error: 'entity required' }, { status: 400 })
      const upserted = await runIncrementalSyncForEntity(entity)
      counts = { [entity]: upserted }
    } else if (action === 'sync-now') {
      // Reference + incremental — same as the daily cron
      const [refCounts, incrCounts] = await Promise.all([
        runReferenceSync(),
        runIncrementalSync(),
      ])
      counts = { ...refCounts, ...incrCounts }
    } else if (action === 'reference') {
      counts = await runReferenceSync()
    } else if (action === 'incremental') {
      counts = await runIncrementalSync()
    } else if (action === 'reconcile') {
      if (entity) {
        // skipExpand re-pulls main job fields only (fast — fits in 300s) which is
        // all that's needed to backfill closed_at; concurrency fetches pages in
        // parallel to beat SF API latency.
        const opts = {
          skipExpand: body.skipExpand === true,
          concurrency: typeof body.concurrency === 'number' ? body.concurrency : 1,
        }
        counts = { [entity]: await runWeeklyReconcileForEntity(entity, opts) }
      } else {
        counts = await runWeeklyReconcile()
      }
    } else if (action === 'backfill') {
      counts = await runBackfill(entity)
    } else if (action === 'reconcile-scoped') {
      const days = typeof body.days === 'number' ? body.days : 120
      const scopeEntities: string[] = Array.isArray(body.entities) ? body.entities : ['jobs', 'estimates']
      counts = await runScopedReconcile(days, scopeEntities)
    } else if (action === 'reprocess-children') {
      const n = await reprocessCustomerChildren()
      counts = { customers_processed: n }
    } else {
      return NextResponse.json({ ok: false, error: `Unknown action: ${action}`, ms: 0 }, { status: 400 })
    }

    return NextResponse.json({ ok: true, counts, ms: Date.now() - t0 })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message, ms: Date.now() - t0 }, { status: 500 })
  }
}
