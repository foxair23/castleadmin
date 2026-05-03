import { createClient } from '@supabase/supabase-js'
import type { CrmProvider, CrmTechnician, CrmJob } from './types'

// NOTE: Verify these URLs against live SF docs at docs.servicefusion.com
// once API credentials are available.
const SF_TOKEN_URL = 'https://api.servicefusion.com/oauth/access_token'
const SF_BASE_URL = 'https://api.servicefusion.com/v1'

// SF status category strings — verify by fetching a sample job and
// inspecting response.status.category on first live connection.
const ASSIGNED_CATEGORIES = new Set([
  'Open Jobs',
  'Open Jobs That Are In Progress',
])
const COMPLETED_CATEGORIES = new Set(['Closed Jobs'])

function adminDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

async function getCachedToken(): Promise<string | null> {
  const { data } = await adminDb()
    .from('crm_tokens')
    .select('access_token, expires_at')
    .eq('provider', 'service_fusion')
    .maybeSingle()
  if (!data) return null
  // Only use token if it has at least 60 s left
  if (new Date(data.expires_at) > new Date(Date.now() + 60_000)) {
    return data.access_token as string
  }
  return null
}

async function fetchNewToken(): Promise<string> {
  const clientId = process.env.SF_CLIENT_ID
  const clientSecret = process.env.SF_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error(
      'SF_CLIENT_ID and SF_CLIENT_SECRET are not set. Add them in Vercel project settings.'
    )
  }

  const resp = await fetch(SF_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  })

  if (!resp.ok) {
    throw new Error(`Service Fusion auth failed (${resp.status}): ${await resp.text()}`)
  }

  const json = await resp.json()
  const token = json.access_token as string
  const expiresIn = (json.expires_in as number) ?? 3600

  await adminDb().from('crm_tokens').upsert({
    provider: 'service_fusion',
    access_token: token,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
  })

  return token
}

async function getToken(): Promise<string> {
  return (await getCachedToken()) ?? (await fetchNewToken())
}

async function sfGet(path: string, params?: Record<string, string>): Promise<unknown> {
  const token = await getToken()
  const url = new URL(`${SF_BASE_URL}${path}`)
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  }

  let lastError: Error = new Error('Request failed')
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 500))

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)

    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout))

    if (resp.status === 429) {
      lastError = new Error('Service Fusion is busy — please try again in a moment.')
      continue
    }
    if (!resp.ok) {
      throw new Error(`Service Fusion API error (${resp.status}): ${await resp.text()}`)
    }
    return resp.json()
  }
  throw lastError
}

export class ServiceFusionProvider implements CrmProvider {
  async testConnection(): Promise<void> {
    await sfGet('/techs', { perPage: '1' })
  }

  async listTechnicians(): Promise<CrmTechnician[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = (await sfGet('/techs', { perPage: '100' })) as any
    const items: unknown[] = json?.items ?? []

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return items.map((t: any) => ({
      id: String(t.id),
      name: `${t.first_name ?? ''} ${t.last_name ?? ''}`.trim(),
    }))
  }

  async listJobsForTech(
    sfTechId: string,
    weekStart: Date,
    weekEnd: Date
  ): Promise<CrmJob[]> {
    const fmt = (d: Date) => d.toISOString().slice(0, 10)

    // NOTE: Verify query param names against live SF docs.
    // SF may use tech_id, assigned_tech_id, or a different param.
    // Date params may be schedule_start/end, start_date/end_date, etc.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = (await sfGet('/jobs', {
      assigned_tech_id: sfTechId,
      schedule_start: fmt(weekStart),
      schedule_end: fmt(weekEnd),
      perPage: '100',
    })) as any

    const items: unknown[] = Array.isArray(json) ? json : (json?.data ?? [])
    const results: CrmJob[] = []

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const job of items as any[]) {
      // NOTE: Verify status field path — may be job.status.category,
      // job.job_status.category, or a different path.
      const category: string =
        job.status?.category ?? job.job_status?.category ?? ''

      let status: 'assigned' | 'completed' | null = null
      if (ASSIGNED_CATEGORIES.has(category)) status = 'assigned'
      else if (COMPLETED_CATEGORIES.has(category)) status = 'completed'
      if (!status) continue  // skip Cancelled, Estimate, etc.

      // NOTE: Verify date field — may be scheduled_start_date, schedule_start, work_date, etc.
      const scheduledDate: string =
        (job.scheduled_start_date ?? job.schedule_start ?? job.work_date ?? fmt(weekStart)).slice(0, 10)

      // NOTE: Verify customer name path — may be customer.full_name, customer_name, etc.
      const customerName: string =
        job.customer?.full_name ??
        job.customer?.name ??
        job.customer_name ??
        `SF Job #${job.id}`

      results.push({
        id: String(job.id),
        customerName,
        scheduledDate,
        status,
        statusLabel: job.status?.name ?? job.job_status?.name ?? category,
      })
    }

    return results
  }
}
