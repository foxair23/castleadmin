import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { enqueueForSubscribers, hasRecentNotification } from '@/lib/notifications/enqueue'
import { renderSyncNotRun } from '@/lib/notifications/templates/sync-not-run'

// Runs daily at 17:00 UTC = 9–10 AM PT
export const maxDuration = 30

const STALE_HOURS = 30
const SYNC_ENTITIES = ['jobs', 'estimates', 'invoices', 'calendar_tasks']
const ADMIN_URL = `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://admin.castlegaragedoors.com'}/admin/integrations`

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = db()

  // Check latest completed run across all entities
  const { data: runs } = await supabase
    .from('sf_sync_runs')
    .select('entity, status, started_at')
    .eq('run_type', 'incremental')
    .eq('status', 'completed')
    .in('entity', SYNC_ENTITIES)
    .order('started_at', { ascending: false })
    .limit(20)

  const cutoff = Date.now() - STALE_HOURS * 3_600_000
  const latestByEntity: Record<string, string> = {}
  for (const run of (runs ?? [])) {
    if (!latestByEntity[run.entity]) latestByEntity[run.entity] = run.started_at
  }

  // Find the most recent successful sync across all entities
  const latestSyncMs = Object.values(latestByEntity).reduce<number>((best, ts) => {
    const ms = new Date(ts).getTime()
    return ms > best ? ms : best
  }, 0)

  const isStale = latestSyncMs === 0 || latestSyncMs < cutoff
  if (!isStale) {
    return NextResponse.json({ ok: true, stale: false })
  }

  // Don't resend if we already sent a sync_not_run in the last 24 hours
  const alreadySent = await hasRecentNotification({
    notificationTypeKey: 'sync_not_run',
    withinHours: 24,
  })

  if (alreadySent) {
    return NextResponse.json({ ok: true, stale: true, skipped: 'already_sent_recently' })
  }

  const hoursSince = latestSyncMs === 0
    ? STALE_HOURS
    : Math.floor((Date.now() - latestSyncMs) / 3_600_000)

  const lastRunAt = latestSyncMs === 0 ? null : formatDateTime(new Date(latestSyncMs))

  const { subject, bodyHtml, bodyText } = renderSyncNotRun({
    hoursSinceLastSync: hoursSince,
    lastRunAt,
    adminUrl: ADMIN_URL,
  })

  const enqueued = await enqueueForSubscribers({
    notificationTypeKey: 'sync_not_run',
    subject,
    bodyHtml,
    bodyText,
    relatedEntityType: 'sf_sync',
    relatedEntityId: 'daily_check',
  })

  return NextResponse.json({ ok: true, stale: true, enqueued })
}

function formatDateTime(d: Date): string {
  return d.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}
