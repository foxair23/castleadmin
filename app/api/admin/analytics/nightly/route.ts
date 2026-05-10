import { NextRequest, NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { ServiceFusionProvider } from '@/lib/crm/service-fusion'
import { runIncrementalSync } from '@/lib/analytics/sync'

export const maxDuration = 300  // 5 min max for nightly

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const today = new Date()
  const dateTo = today.toISOString().slice(0, 10)
  const dateFrom = new Date(today.getTime() - 7 * 86_400_000).toISOString().slice(0, 10)

  const { data: log } = await db.from('analytics_sync_log').insert({
    sync_type: 'nightly',
    entity: 'all',
    status: 'running',
    started_at: new Date().toISOString(),
  }).select('id').single()

  try {
    const provider = new ServiceFusionProvider()
    const stats = await runIncrementalSync(db, provider as any, dateFrom, dateTo, log!.id)
    return NextResponse.json({ ok: true, ...stats })
  } catch (err: unknown) {
    await db.from('analytics_sync_log').update({
      status: 'error',
      completed_at: new Date().toISOString(),
      error_message: err instanceof Error ? err.message : 'Unknown error',
    }).eq('id', log!.id)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
