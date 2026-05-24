import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as serviceClient } from '@supabase/supabase-js'
import { sfGet } from '@/lib/crm/service-fusion'

export const maxDuration = 30

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: p } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (p?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const results: Record<string, unknown> = {}

  // Try fetching services off a recently synced job by ID
  try {
    const db = serviceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    )
    const { data: syncedLeads } = await db
      .from('scheduler_leads')
      .select('service_fusion_job_id')
      .eq('sync_status', 'synced')
      .not('service_fusion_job_id', 'is', null)
      .order('synced_at', { ascending: false })
      .limit(5)

    const jobServiceResults: unknown[] = []
    for (const lead of syncedLeads ?? []) {
      if (!lead.service_fusion_job_id) continue
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const jobServices = (await sfGet(`/jobs/${lead.service_fusion_job_id}/services`, { 'per-page': '100' })) as any
        jobServiceResults.push({ job_id: lead.service_fusion_job_id, data: jobServices })
      } catch (err) {
        jobServiceResults.push({ job_id: lead.service_fusion_job_id, error: err instanceof Error ? err.message : String(err) })
      }
    }
    results['job_services_by_id'] = jobServiceResults
  } catch (err) {
    results['job_services_by_id'] = { error: err instanceof Error ? err.message : String(err) }
  }

  // Fetch all services via paginated /job-services endpoint
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = (await sfGet('/job-services', { 'per-page': '200' })) as any
    results['/job-services'] = json
  } catch (err) {
    results['/job-services'] = { error: err instanceof Error ? err.message : String(err) }
  }

  // Try paginated /jobs?expand=services to collect all unique service names
  try {
    const allServiceNames = new Set<string>()
    for (let page = 1; page <= 5; page++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json = (await sfGet('/jobs', { 'per-page': '50', page: String(page), sort: '-id', expand: 'services' })) as any
      const items: unknown[] = json?.items ?? []
      if (items.length === 0) break
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const job of items as any[]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const svc of (job.services ?? []) as any[]) {
          if (svc.name) allServiceNames.add(svc.name)
          if (svc.short_description) allServiceNames.add(svc.short_description)
        }
      }
    }
    results['service_names_from_jobs'] = Array.from(allServiceNames).sort()
  } catch (err) {
    results['service_names_from_jobs'] = { error: err instanceof Error ? err.message : String(err) }
  }

  return NextResponse.json(results)
}
