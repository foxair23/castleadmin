import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { ServiceFusionProvider } from '@/lib/crm/service-fusion'
import { syncRefTables, processJobsBatch, processInvoices, processEstimates, processCustomers, detectCallbacks } from '@/lib/analytics/sync'

export const maxDuration = 60

// Each POST processes exactly ONE page and returns immediately.
// The client loops, passing resume_id until done: true.

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  const resumeId: string | null = body.resume_id ?? null

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const provider = new ServiceFusionProvider()

  let logId: string
  let entity: string
  let nextPage: number
  let recordsSyncedSoFar: number

  if (resumeId) {
    const { data: existing } = await db
      .from('analytics_sync_log')
      .select('*')
      .eq('id', resumeId)
      .single()
    if (!existing) return NextResponse.json({ error: 'Log not found' }, { status: 404 })
    logId = resumeId
    entity = existing.entity
    nextPage = (existing.last_page ?? 0) + 1
    recordsSyncedSoFar = existing.records_synced ?? 0
    await db.from('analytics_sync_log').update({ status: 'running' }).eq('id', logId)
  } else {
    entity = body.entity ?? 'jobs'
    nextPage = 1
    recordsSyncedSoFar = 0

    // Sync ref tables only on the very first call (page 1 of jobs)
    if (entity === 'jobs') {
      await syncRefTables(db, provider as any)
    }

    const { data: log } = await db.from('analytics_sync_log').insert({
      sync_type: 'backfill',
      entity,
      status: 'running',
      started_at: new Date().toISOString(),
      last_page: 0,
      records_synced: 0,
    }).select('id').single()
    logId = log!.id
  }

  try {
    let pageCount = 1
    let totalCount = 0
    let recordsThisPage = 0

    if (entity === 'jobs') {
      const resp = await (provider as any).listJobsPaged(nextPage, 50)
      pageCount = resp._meta.pageCount
      totalCount = resp._meta.totalCount
      recordsThisPage = await processJobsBatch(db, resp.items, { isBackfill: true })
      await detectCallbacks(db, resp.items.map((r: { id: number | string }) => String(r.id)))
    } else if (entity === 'invoices') {
      const resp = await (provider as any).listInvoicesPaged(nextPage, 100)
      pageCount = resp._meta.pageCount
      totalCount = resp._meta.totalCount
      recordsThisPage = await processInvoices(db, resp.items)
    } else if (entity === 'estimates') {
      const resp = await (provider as any).listEstimatesPaged(nextPage, 100)
      pageCount = resp._meta.pageCount
      totalCount = resp._meta.totalCount
      recordsThisPage = await processEstimates(db, resp.items)
    } else if (entity === 'customers') {
      const resp = await (provider as any).listCustomersPaged(nextPage, 100)
      pageCount = resp._meta.pageCount
      totalCount = resp._meta.totalCount
      recordsThisPage = await processCustomers(db, resp.items)
    }

    const newTotal = recordsSyncedSoFar + recordsThisPage
    const done = nextPage >= pageCount

    await db.from('analytics_sync_log').update({
      last_page: nextPage,
      records_synced: newTotal,
      records_total: totalCount,
      status: done ? 'complete' : 'partial',
      ...(done ? { completed_at: new Date().toISOString() } : {}),
    }).eq('id', logId)

    return NextResponse.json({
      done,
      log_id: logId,
      resume_id: done ? null : logId,
      entity,
      page: nextPage,
      pages_total: pageCount,
      records_synced: newTotal,
      records_total: totalCount,
    })
  } catch (err: unknown) {
    await db.from('analytics_sync_log').update({
      status: 'error',
      completed_at: new Date().toISOString(),
      error_message: err instanceof Error ? err.message : 'Unknown error',
    }).eq('id', logId)
    return NextResponse.json({
      error: err instanceof Error ? err.message : 'Backfill failed',
      log_id: logId,
      resume_id: logId,
    }, { status: 500 })
  }
}

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: logs } = await db
    .from('analytics_sync_log')
    .select('*')
    .eq('sync_type', 'backfill')
    .order('started_at', { ascending: false })
    .limit(10)

  return NextResponse.json({ logs: logs ?? [] })
}
