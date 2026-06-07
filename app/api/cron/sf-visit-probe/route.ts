import { NextResponse } from 'next/server'
import { sfGet } from '@/lib/crm/service-fusion'

// Temporary diagnostic endpoint — delete after confirming visit structure
// Hit: GET /api/cron/sf-visit-probe
export async function GET() {
  // Step 1: fetch 3 recent jobs (no expand — just to get IDs quickly)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let jobsJson: any
  try {
    jobsJson = await sfGet('/jobs', { 'per-page': '3', page: '1' })
  } catch (err) {
    return NextResponse.json({ step: 'list_jobs', error: String(err) }, { status: 502 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jobs: any[] = jobsJson?.items ?? []
  if (jobs.length === 0) {
    return NextResponse.json({ step: 'list_jobs', job_count: 0, jobs: [] })
  }

  const firstId = jobs[0].id

  // Step 2: fetch that single job with expand=visits
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let singleJson: any
  try {
    singleJson = await sfGet(`/jobs/${firstId}`, { expand: 'visits' })
  } catch (err) {
    return NextResponse.json({
      step: 'single_job_with_visits',
      job_id: firstId,
      error: String(err),
      // Return bare job list so we at least have IDs
      bare_jobs: jobs.map((j: any) => ({ id: j.id, number: j.number, customer: j.customer_name, start_date: j.start_date })),
    }, { status: 502 })
  }

  return NextResponse.json({
    first_job_id: firstId,
    visit_count: Array.isArray(singleJson?.visits) ? singleJson.visits.length : 'not an array',
    visits_raw: singleJson?.visits,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bare_jobs: jobs.map((j: any) => ({ id: j.id, number: j.number, customer: j.customer_name, start_date: j.start_date })),
  })
}
