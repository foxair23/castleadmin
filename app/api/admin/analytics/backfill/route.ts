import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { ServiceFusionProvider } from '@/lib/crm/service-fusion'
import { processJobsBatch, processInvoices, processEstimates, processCustomers, detectCallbacks } from '@/lib/analytics/sync'

export const maxDuration = 60

// ── Two-phase backfill ────────────────────────────────────────────────────
//
// Each page requires two sequential client requests to stay under 10s:
//
//  Phase "fetch"  — auth + one SF API call, no DB writes   (~2–7 s)
//  Phase "write"  — auth + DB writes only, no SF API call  (~1 s)
//
// The client alternates fetch → write for every page.

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: p } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (p?.role !== 'admin') return null
  return user
}

function adminDb() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function POST(req: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const phase: 'fetch' | 'write' = body.phase ?? 'fetch'

  // ── FETCH PHASE ───────────────────────────────────────────────────────
  // Calls the SF API for one page and returns raw items — no DB writes.
  if (phase === 'fetch') {
    const entity: string = body.entity ?? 'jobs'
    const page: number = body.page ?? 1
    const provider = new ServiceFusionProvider()

    try {
      let items: unknown[] = []
      let pagesTotal = 1
      let totalCount = 0

      if (entity === 'jobs') {
        const resp = await (provider as any).listJobsPaged(page, 50)
        items = resp.items
        pagesTotal = resp._meta.pageCount
        totalCount = resp._meta.totalCount
        // Temporary: log raw field names on page 1 so we can verify SF API shape
        if (page === 1 && resp.items.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const first = resp.items[0] as any
          console.log('SF job keys:', Object.keys(first).join(', '))
          console.log('SF job sample (no PII):', JSON.stringify({
            id: first.id, number: first.number, status: first.status,
            status_id: first.status_id, category: first.category,
            category_id: first.category_id, start_date: first.start_date,
            end_date: first.end_date, completed_date: first.completed_date,
            created: first.created, total: first.total,
            lead_source: first.lead_source, zip: first.zip,
            _meta_keys: Object.keys(resp._meta).join(', '),
          }))
        }
      } else if (entity === 'invoices') {
        const resp = await (provider as any).listInvoicesPaged(page, 100)
        items = resp.items
        pagesTotal = resp._meta.pageCount
        totalCount = resp._meta.totalCount
      } else if (entity === 'estimates') {
        const resp = await (provider as any).listEstimatesPaged(page, 100)
        items = resp.items
        pagesTotal = resp._meta.pageCount
        totalCount = resp._meta.totalCount
      } else if (entity === 'customers') {
        const resp = await (provider as any).listCustomersPaged(page, 100)
        items = resp.items
        pagesTotal = resp._meta.pageCount
        totalCount = resp._meta.totalCount
      }

      return NextResponse.json({ ok: true, entity, page, pages_total: pagesTotal, total_count: totalCount, items })
    } catch (err: unknown) {
      return NextResponse.json({ error: err instanceof Error ? err.message : 'Fetch failed' }, { status: 500 })
    }
  }

  // ── WRITE PHASE ───────────────────────────────────────────────────────
  // Receives items from the client and writes them to the DB — no SF API calls.
  if (phase === 'write') {
    const entity: string = body.entity ?? 'jobs'
    const page: number = body.page ?? 1
    const pagesTotal: number = body.pages_total ?? 1
    const totalCount: number = body.total_count ?? 0
    const items: unknown[] = body.items ?? []
    const logId: string | null = body.log_id ?? null

    const db = adminDb()

    try {
      // Create or update sync log
      let currentLogId: string
      if (logId) {
        currentLogId = logId
        await db.from('analytics_sync_log').update({ status: 'running' }).eq('id', currentLogId)
      } else {
        const { data: log } = await db.from('analytics_sync_log').insert({
          sync_type: 'backfill',
          entity,
          status: 'running',
          started_at: new Date().toISOString(),
          last_page: 0,
          records_synced: 0,
        }).select('id').single()
        currentLogId = log!.id
      }

      // Write to DB
      let recordsThisPage = 0
      if (entity === 'jobs') {
        recordsThisPage = await processJobsBatch(db, items as any[], { isBackfill: true })
        await detectCallbacks(db, (items as any[]).map((r: any) => String(r.id)))
      } else if (entity === 'invoices') {
        recordsThisPage = await processInvoices(db, items as any[])
      } else if (entity === 'estimates') {
        recordsThisPage = await processEstimates(db, items as any[])
      } else if (entity === 'customers') {
        recordsThisPage = await processCustomers(db, items as any[])
      }

      const done = page >= pagesTotal

      // Get running total from log
      const { data: existing } = await db
        .from('analytics_sync_log')
        .select('records_synced')
        .eq('id', currentLogId)
        .single()
      const newTotal = (existing?.records_synced ?? 0) + recordsThisPage

      await db.from('analytics_sync_log').update({
        last_page: page,
        records_synced: newTotal,
        records_total: totalCount,
        status: done ? 'complete' : 'partial',
        ...(done ? { completed_at: new Date().toISOString() } : {}),
      }).eq('id', currentLogId)

      return NextResponse.json({
        ok: true,
        done,
        log_id: currentLogId,
        page,
        pages_total: pagesTotal,
        records_synced: newTotal,
        records_total: totalCount,
      })
    } catch (err: unknown) {
      if (logId) {
        await db.from('analytics_sync_log').update({
          status: 'error',
          completed_at: new Date().toISOString(),
          error_message: err instanceof Error ? err.message : 'Write failed',
        }).eq('id', logId)
      }
      return NextResponse.json({ error: err instanceof Error ? err.message : 'Write failed' }, { status: 500 })
    }
  }

  return NextResponse.json({ error: 'Invalid phase' }, { status: 400 })
}

export async function GET() {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: logs } = await adminDb()
    .from('analytics_sync_log')
    .select('*')
    .eq('sync_type', 'backfill')
    .order('started_at', { ascending: false })
    .limit(10)

  return NextResponse.json({ logs: logs ?? [] })
}
