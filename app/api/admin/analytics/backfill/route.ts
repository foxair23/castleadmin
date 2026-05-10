import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { ServiceFusionProvider } from '@/lib/crm/service-fusion'
import { syncRefTables, processJob, processInvoices, processEstimates, processCustomers, detectCallbacks } from '@/lib/analytics/sync'

export const maxDuration = 60

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

  // Resume or start
  let logId: string
  let entity: string = body.entity ?? 'jobs'
  let startPage = 1

  if (resumeId) {
    const { data: existing } = await db.from('analytics_sync_log').select('*').eq('id', resumeId).single()
    if (!existing) return NextResponse.json({ error: 'Log not found' }, { status: 404 })
    logId = resumeId
    entity = existing.entity
    startPage = (existing.last_page ?? 0) + 1
    await db.from('analytics_sync_log').update({ status: 'running' }).eq('id', logId)
  } else {
    // Sync ref tables on fresh start
    await syncRefTables(db, provider as any)

    const { data: log } = await db.from('analytics_sync_log').insert({
      sync_type: 'backfill',
      entity,
      status: 'running',
      started_at: new Date().toISOString(),
      last_page: 0,
    }).select('id').single()
    logId = log!.id
  }

  const PER_PAGE = 50
  let recordsSynced = 0
  let lastPage = startPage - 1
  const jobIdsThisBatch: string[] = []

  try {
    if (entity === 'jobs') {
      let page = startPage
      while (true) {
        const resp = await (provider as any).listJobsPaged(page, PER_PAGE)
        for (const raw of resp.items) {
          await processJob(db, raw, { isBackfill: true })
          jobIdsThisBatch.push(String(raw.id))
          recordsSynced++
        }
        lastPage = page
        await db.from('analytics_sync_log').update({
          last_page: lastPage,
          records_synced: recordsSynced,
          records_total: resp._meta.totalCount,
          status: 'partial',
        }).eq('id', logId)

        if (page >= resp._meta.pageCount) {
          await detectCallbacks(db, jobIdsThisBatch)
          await db.from('analytics_sync_log').update({ status: 'complete', completed_at: new Date().toISOString() }).eq('id', logId)
          break
        }
        page++
        // Rate limit buffer
        await new Promise(r => setTimeout(r, 300))
      }
    } else if (entity === 'invoices') {
      let page = startPage
      while (true) {
        const resp = await (provider as any).listInvoicesPaged(page, 100)
        recordsSynced += await processInvoices(db, resp.items)
        lastPage = page
        await db.from('analytics_sync_log').update({
          last_page: lastPage, records_synced: recordsSynced, records_total: resp._meta.totalCount, status: 'partial',
        }).eq('id', logId)
        if (page >= resp._meta.pageCount) {
          await db.from('analytics_sync_log').update({ status: 'complete', completed_at: new Date().toISOString() }).eq('id', logId)
          break
        }
        page++
        await new Promise(r => setTimeout(r, 300))
      }
    } else if (entity === 'estimates') {
      let page = startPage
      while (true) {
        const resp = await (provider as any).listEstimatesPaged(page, 100)
        recordsSynced += await processEstimates(db, resp.items)
        lastPage = page
        await db.from('analytics_sync_log').update({
          last_page: lastPage, records_synced: recordsSynced, records_total: resp._meta.totalCount, status: 'partial',
        }).eq('id', logId)
        if (page >= resp._meta.pageCount) {
          await db.from('analytics_sync_log').update({ status: 'complete', completed_at: new Date().toISOString() }).eq('id', logId)
          break
        }
        page++
        await new Promise(r => setTimeout(r, 300))
      }
    } else if (entity === 'customers') {
      let page = startPage
      while (true) {
        const resp = await (provider as any).listCustomersPaged(page, 100)
        recordsSynced += await processCustomers(db, resp.items)
        lastPage = page
        await db.from('analytics_sync_log').update({
          last_page: lastPage, records_synced: recordsSynced, records_total: resp._meta.totalCount, status: 'partial',
        }).eq('id', logId)
        if (page >= resp._meta.pageCount) {
          await db.from('analytics_sync_log').update({ status: 'complete', completed_at: new Date().toISOString() }).eq('id', logId)
          break
        }
        page++
        await new Promise(r => setTimeout(r, 300))
      }
    }

    return NextResponse.json({ ok: true, log_id: logId, records_synced: recordsSynced, entity })
  } catch (err: unknown) {
    await db.from('analytics_sync_log').update({
      status: 'error',
      completed_at: new Date().toISOString(),
      error_message: err instanceof Error ? err.message : 'Unknown error',
      last_page: lastPage,
    }).eq('id', logId)
    return NextResponse.json({
      error: err instanceof Error ? err.message : 'Backfill failed',
      log_id: logId,
      resume_id: logId,
    }, { status: 500 })
  }
}

export async function GET() {
  // Return status of most recent backfill runs
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
