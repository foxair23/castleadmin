import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { ServiceFusionProvider } from '@/lib/crm/service-fusion'
import { runIncrementalSync } from '@/lib/analytics/sync'

export const maxDuration = 60

export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const today = new Date()
  const dateTo = today.toISOString().slice(0, 10)
  const dateFrom = new Date(today.getTime() - 7 * 86_400_000).toISOString().slice(0, 10)

  // Insert sync log entry
  const { data: log } = await db.from('analytics_sync_log').insert({
    sync_type: 'manual',
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
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Sync failed' }, { status: 500 })
  }
}
