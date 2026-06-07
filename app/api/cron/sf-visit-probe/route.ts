import { NextResponse } from 'next/server'
import { getToken } from '@/lib/crm/service-fusion'

// Temporary diagnostic endpoint — delete after confirming visit structure
// Hit: GET /api/cron/sf-visit-probe
export async function GET() {
  const t0 = Date.now()

  // Step 1: get token (may hit Supabase + SF OAuth if expired)
  let token: string
  try {
    token = await getToken()
  } catch (err) {
    return NextResponse.json({ step: 'get_token', error: String(err), ms: Date.now() - t0 }, { status: 502 })
  }
  const tokenMs = Date.now() - t0

  // Step 2: fetch 3 jobs — no expand, 25s timeout
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 25_000)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let jobsJson: any
  try {
    const res = await fetch(
      'https://api.servicefusion.com/v1/jobs?' +
        new URLSearchParams({ 'per-page': '3', page: '1' }),
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: controller.signal }
    )
    clearTimeout(timer)
    if (!res.ok) {
      return NextResponse.json({ step: 'list_jobs', status: res.status, body: await res.text(), token_ms: tokenMs }, { status: 502 })
    }
    jobsJson = await res.json()
  } catch (err) {
    clearTimeout(timer)
    return NextResponse.json({ step: 'list_jobs', error: String(err), token_ms: tokenMs, total_ms: Date.now() - t0 }, { status: 502 })
  }

  const listMs = Date.now() - t0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jobs: any[] = jobsJson?.items ?? []

  if (jobs.length === 0) {
    return NextResponse.json({ step: 'list_jobs', job_count: 0, token_ms: tokenMs, list_ms: listMs })
  }

  const firstId = jobs[0].id

  // Step 3: fetch single job with expand=visits, 25s timeout
  const c2 = new AbortController()
  const t2 = setTimeout(() => c2.abort(), 25_000)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let singleJson: any
  try {
    const res = await fetch(
      `https://api.servicefusion.com/v1/jobs/${firstId}?` +
        new URLSearchParams({ expand: 'visits' }),
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: c2.signal }
    )
    clearTimeout(t2)
    if (!res.ok) {
      return NextResponse.json({ step: 'single_job', status: res.status, body: await res.text(), token_ms: tokenMs, list_ms: listMs }, { status: 502 })
    }
    singleJson = await res.json()
  } catch (err) {
    clearTimeout(t2)
    return NextResponse.json({
      step: 'single_job_with_visits',
      error: String(err),
      token_ms: tokenMs,
      list_ms: listMs,
      total_ms: Date.now() - t0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bare_jobs: jobs.map((j: any) => ({ id: j.id, number: j.number, customer: j.customer_name, start_date: j.start_date })),
    }, { status: 502 })
  }

  return NextResponse.json({
    token_ms: tokenMs,
    list_ms: listMs,
    total_ms: Date.now() - t0,
    first_job_id: firstId,
    visit_count: Array.isArray(singleJson?.visits) ? singleJson.visits.length : 'not an array',
    visits_raw: singleJson?.visits,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bare_jobs: jobs.map((j: any) => ({ id: j.id, number: j.number, customer: j.customer_name, start_date: j.start_date })),
  })
}
