/**
 * Deprecated — superseded by /api/cron/sf-sync-daily (migration 018).
 * The Phase 1 _cache tables have been replaced by compatibility views
 * backed by the full SF mirror. The old runIncrementalSync (lib/analytics/sync)
 * wrote directly to those tables and can no longer be used.
 */
import { NextResponse } from 'next/server'

export const maxDuration = 10

export async function GET() {
  return NextResponse.json(
    { ok: false, message: 'Deprecated — use /api/cron/sf-sync-daily' },
    { status: 410 }
  )
}
