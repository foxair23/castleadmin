import { NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

const STALE_HOURS = 30
const SYNC_ENTITIES = ['jobs', 'estimates', 'invoices', 'calendar_tasks']

function db() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

export async function GET() {
  // Count any real sync as fresh — not just incremental. These entities sync
  // incrementally Mon–Sat and via the weekly reconcile on Sunday, so ignoring
  // reconcile/backfill would falsely flag them as stale every Sunday.
  const { data: runs } = await db()
    .from('sf_sync_runs')
    .select('entity, run_type, status, started_at, error_message')
    .in('run_type', ['incremental', 'reconcile', 'backfill'])
    .in('entity', SYNC_ENTITIES)
    .order('started_at', { ascending: false })
    .limit(80)

  // Latest run per entity
  const latestByEntity: Record<string, { status: string; started_at: string; error_message: string | null }> = {}
  for (const run of (runs ?? [])) {
    if (!latestByEntity[run.entity]) latestByEntity[run.entity] = run
  }

  const cutoff = Date.now() - STALE_HOURS * 3_600_000
  const staleEntities: string[] = []
  const errors: string[] = []

  for (const entity of SYNC_ENTITIES) {
    const run = latestByEntity[entity]
    if (!run || run.status !== 'completed' || new Date(run.started_at).getTime() < cutoff) {
      staleEntities.push(entity)
    }
    if (run?.status === 'failed' && run.error_message) {
      errors.push(`${entity}: ${run.error_message.slice(0, 120)}`)
    }
  }

  return NextResponse.json({
    stale: staleEntities.length > 0,
    staleEntities,
    errors,
  })
}
