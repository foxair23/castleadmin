import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { sfGet } from '@/lib/crm/service-fusion'

export const maxDuration = 30

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: p } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (p?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const results: Record<string, unknown> = {}

  // Try known catalog-style endpoints
  const endpoints = [
    '/services',
    '/price-book',
    '/price-book-items',
  ]

  for (const ep of endpoints) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json = (await sfGet(ep, { 'per-page': '100' })) as any
      results[ep] = json
    } catch (err) {
      results[ep] = { error: err instanceof Error ? err.message : String(err) }
    }
  }

  // Also pull services off the most recent job that has them
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recentJobs = (await sfGet('/jobs', { 'per-page': '20', page: '1', sort: '-id', expand: 'services' })) as any
    const jobsWithServices = (recentJobs?.items ?? []).filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (j: any) => Array.isArray(j.services) && j.services.length > 0
    )
    results['recent_job_services'] = jobsWithServices.map((j: { id: unknown; number: unknown; services: unknown }) => ({
      job_id: j.id,
      job_number: j.number,
      services: j.services,
    }))
  } catch (err) {
    results['recent_job_services'] = { error: err instanceof Error ? err.message : String(err) }
  }

  return NextResponse.json(results)
}
