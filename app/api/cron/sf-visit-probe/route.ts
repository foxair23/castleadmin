import { NextResponse } from 'next/server'
import { getToken } from '@/lib/crm/service-fusion'

// Temporary diagnostic endpoint — delete after confirming visit structure
// Hit: GET /api/cron/sf-visit-probe
export async function GET() {
  const t0 = Date.now()

  let token: string
  try {
    token = await getToken()
  } catch (err) {
    return NextResponse.json({ step: 'get_token', error: String(err), ms: Date.now() - t0 }, { status: 502 })
  }
  const tokenMs = Date.now() - t0

  async function sfFetch(label: string, url: string) {
    const c = new AbortController()
    const timer = setTimeout(() => c.abort(), 20_000)
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: c.signal,
      })
      clearTimeout(timer)
      const ms = Date.now() - t0
      if (!res.ok) return { label, ok: false, status: res.status, body: await res.text(), ms }
      const json = await res.json()
      return { label, ok: true, ms, json }
    } catch (err) {
      clearTimeout(timer)
      return { label, ok: false, error: String(err), ms: Date.now() - t0 }
    }
  }

  // Test 1: /techs — simplest possible call
  const techs = await sfFetch(
    'GET /techs?per-page=1',
    'https://api.servicefusion.com/v1/techs?' + new URLSearchParams({ 'per-page': '1' })
  )
  if (!techs.ok) {
    return NextResponse.json({ token_ms: tokenMs, techs }, { status: 502 })
  }

  // Test 2: /jobs with date filter — avoid full-table scan
  const today = new Date().toISOString().slice(0, 10)
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10)
  const jobs = await sfFetch(
    'GET /jobs with date filter',
    'https://api.servicefusion.com/v1/jobs?' +
      new URLSearchParams({
        'per-page': '3',
        page: '1',
        'filters[start_date][gte]': weekAgo,
        'filters[start_date][lte]': today,
      })
  )
  if (!jobs.ok) {
    return NextResponse.json({ token_ms: tokenMs, techs: { ok: true, ms: techs.ms }, jobs }, { status: 502 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jobItems: any[] = jobs.json?.items ?? []
  if (jobItems.length === 0) {
    return NextResponse.json({ token_ms: tokenMs, techs: { ok: true, ms: techs.ms }, jobs: { ok: true, ms: jobs.ms, count: 0 } })
  }

  // Test 3: single job with expand=visits
  const firstId = jobItems[0].id
  const visit = await sfFetch(
    `GET /jobs/${firstId}?expand=visits`,
    `https://api.servicefusion.com/v1/jobs/${firstId}?` + new URLSearchParams({ expand: 'visits' })
  )

  return NextResponse.json({
    token_ms: tokenMs,
    techs: { ok: true, ms: techs.ms },
    jobs: {
      ok: true,
      ms: jobs.ms,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      items: jobItems.map((j: any) => ({ id: j.id, number: j.number, customer: j.customer_name, start_date: j.start_date })),
    },
    visit_probe: visit.ok
      ? {
          ok: true,
          ms: visit.ms,
          job_id: firstId,
          visit_count: Array.isArray(visit.json?.visits) ? visit.json.visits.length : 'not an array',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          visits: Array.isArray(visit.json?.visits) ? visit.json.visits.map((v: any) => ({
            id: v.id,
            start_date: v.start_date,
            time_frame_promised_start: v.time_frame_promised_start,
            time_frame_promised_end: v.time_frame_promised_end,
            techs_assigned: v.techs_assigned,
          })) : visit.json?.visits,
        }
      : { ok: false, ms: visit.ms, error: visit.error, status: visit.status },
  })
}
