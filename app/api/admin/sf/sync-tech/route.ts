import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { ServiceFusionProvider } from '@/lib/crm/service-fusion'

export const maxDuration = 60

function adminDb() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

function isClosed(statusName: string | undefined): boolean {
  const s = (statusName ?? '').toLowerCase()
  return s.includes('closed') || s.includes('completed') || s.includes('invoiced') || s.includes('paid')
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: p } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (p?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json()
  const sfTechId = body?.sf_tech_id ? String(body.sf_tech_id) : null
  if (!sfTechId) return NextResponse.json({ error: 'sf_tech_id required' }, { status: 400 })

  // How many days back to scan — default 90, max 365
  const days = Math.min(365, Math.max(1, Number(body?.days ?? 90) || 90))
  const dateFrom = fmt(new Date(Date.now() - days * 24 * 60 * 60 * 1000))
  const dateTo = fmt(new Date())

  try {
    const sf = new ServiceFusionProvider()
    const db = adminDb()
    const now = new Date().toISOString()

    let page = 1
    let scanned = 0
    let jobsMatched = 0
    let techRowsUpserted = 0

    while (true) {
      const result = await sf.listJobsPaged(page, 50, {
        'filters[start_date][gte]': dateFrom,
        'filters[start_date][lte]': dateTo,
      })
      const items = result.items
      if (items.length === 0) break

      scanned += items.length

      const jobRows = []
      const techRows = []

      for (const raw of items) {
        const techs = raw.techs_assigned ?? []
        const isAssigned = techs.some(t => String(t.id) === sfTechId)
        if (!isAssigned) continue

        const jobId = String(raw.id)
        const statusName = raw.status ?? ''
        const closed = isClosed(statusName)

        jobRows.push({
          id: jobId,
          customer_id: raw.customer_id ? String(raw.customer_id) : null,
          category_name: raw.category ?? null,
          status_name: statusName,
          status_category: closed ? 'Closed Jobs' : 'Open Jobs',
          is_closed: closed,
          created_at_sf: raw.created_at ? new Date(raw.created_at).toISOString() : null,
          scheduled_at: raw.start_date ? new Date(raw.start_date).toISOString() : null,
          completed_at: raw.closed_at ? new Date(raw.closed_at).toISOString() : null,
          total_amount: raw.total != null ? parseFloat(String(raw.total)) : null,
          lead_source: raw.source ?? null,
          zip: raw.postal_code ?? null,
          synced_at: now,
        })

        techRows.push({ sf_job_id: jobId, sf_tech_id: sfTechId, synced_at: now })

        for (const t of techs) {
          const tid = String(t.id)
          if (tid !== sfTechId) {
            techRows.push({ sf_job_id: jobId, sf_tech_id: tid, synced_at: now })
          }
        }
      }

      if (jobRows.length > 0) {
        const { error: jobErr } = await db
          .from('sf_jobs_cache')
          .upsert(jobRows, { onConflict: 'id' })
        if (jobErr) return NextResponse.json({ error: `jobs upsert: ${jobErr.message}` }, { status: 500 })

        const { error: techErr } = await db
          .from('sf_job_techs_cache')
          .upsert(techRows, { onConflict: 'sf_job_id,sf_tech_id' })
        if (techErr) return NextResponse.json({ error: `techs upsert: ${techErr.message}` }, { status: 500 })

        jobsMatched += jobRows.length
        techRowsUpserted += techRows.length
      }

      if (page >= result._meta.pageCount) break
      page++
    }

    return NextResponse.json({ ok: true, scanned, jobsMatched, techRowsUpserted, dateFrom, dateTo })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
