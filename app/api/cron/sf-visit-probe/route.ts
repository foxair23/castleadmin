import { NextResponse } from 'next/server'
import { getToken } from '@/lib/crm/service-fusion'

// Temporary diagnostic endpoint — delete after confirming visit structure
// Hit: GET /api/cron/sf-visit-probe
export async function GET() {
  const token = await getToken()

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15_000)

  let res: Response
  try {
    res = await fetch(
      'https://api.servicefusion.com/v1/jobs?' +
      new URLSearchParams({
        'per-page': '3',
        page: '1',
        expand: 'visits',
      }),
      { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal }
    )
  } catch (err) {
    clearTimeout(timeoutId)
    return NextResponse.json({ error: String(err) }, { status: 504 })
  }
  clearTimeout(timeoutId)

  if (!res.ok) {
    return NextResponse.json({ error: await res.text() }, { status: res.status })
  }

  const json = await res.json()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const summary = (json?.items ?? []).map((job: any) => ({
    sf_job_id: job.id,
    sf_job_number: job.number,
    customer: job.customer_name,
    start_date: job.start_date,
    visit_count: Array.isArray(job.visits) ? job.visits.length : 'not an array',
    visits: Array.isArray(job.visits)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? job.visits.map((v: any) => ({
          id: v.id,
          start_date: v.start_date,
          notes_for_techs: v.notes_for_techs,
          time_frame_promised_start: v.time_frame_promised_start,
          time_frame_promised_end: v.time_frame_promised_end,
          techs_assigned: v.techs_assigned,
        }))
      : job.visits,
  }))

  return NextResponse.json({ job_count: summary.length, jobs: summary })
}
