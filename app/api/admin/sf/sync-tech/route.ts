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

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: p } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (p?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json()
  const sfTechId = body?.sf_tech_id ? String(body.sf_tech_id) : null
  if (!sfTechId) return NextResponse.json({ error: 'sf_tech_id required' }, { status: 400 })

  try {
    const sf = new ServiceFusionProvider()
    const db = adminDb()
    const now = new Date().toISOString()

    let page = 1
    let totalJobs = 0
    let totalTechRows = 0

    while (true) {
      // SF API uses bracket notation for filters, same as the backfill script
      const result = await sf.listJobsPaged(page, 50, { 'filters[tech_id]': sfTechId })
      const items = result.items

      if (items.length === 0) break

      const jobRows = []
      const techRows = []

      for (const raw of items) {
        const jobId = String(raw.id)
        const statusName = raw.status ?? ''
        const closed = isClosed(statusName)
        const scheduledAt = raw.start_date ? new Date(raw.start_date).toISOString() : null
        const completedAt = raw.closed_at ? new Date(raw.closed_at).toISOString() : null
        const createdAtSf = raw.created_at ? new Date(raw.created_at).toISOString() : null

        jobRows.push({
          id: jobId,
          customer_id: raw.customer_id ? String(raw.customer_id) : null,
          category_name: raw.category ?? null,
          status_name: statusName,
          status_category: closed ? 'Closed Jobs' : 'Open Jobs',
          is_closed: closed,
          created_at_sf: createdAtSf,
          scheduled_at: scheduledAt,
          completed_at: completedAt,
          total_amount: raw.total != null ? parseFloat(String(raw.total)) : null,
          lead_source: raw.source ?? null,
          zip: raw.postal_code ?? null,
          synced_at: now,
        })

        // Always explicitly add this tech even if techs_assigned is sparse
        techRows.push({ sf_job_id: jobId, sf_tech_id: sfTechId, synced_at: now })

        // Also add any other techs returned in techs_assigned
        for (const t of raw.techs_assigned ?? []) {
          const tid = String(t.id)
          if (tid !== sfTechId) {
            techRows.push({ sf_job_id: jobId, sf_tech_id: tid, synced_at: now })
          }
        }
      }

      const { error: jobErr } = await db
        .from('sf_jobs_cache')
        .upsert(jobRows, { onConflict: 'id' })
      if (jobErr) return NextResponse.json({ error: `jobs upsert: ${jobErr.message}` }, { status: 500 })

      if (techRows.length > 0) {
        const { error: techErr } = await db
          .from('sf_job_techs_cache')
          .upsert(techRows, { onConflict: 'sf_job_id,sf_tech_id' })
        if (techErr) return NextResponse.json({ error: `techs upsert: ${techErr.message}` }, { status: 500 })
      }

      totalJobs += items.length
      totalTechRows += techRows.length

      if (page >= result._meta.pageCount) break
      page++
    }

    return NextResponse.json({ ok: true, jobsSynced: totalJobs, techRowsUpserted: totalTechRows })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
