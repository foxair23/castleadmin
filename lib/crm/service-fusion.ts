import { createClient } from '@supabase/supabase-js'
import type { CrmProvider, CrmTechnician, CrmJob, AnalyticsCrmProvider, SfRawStatus, SfRawCategory, SfRawJob, SfRawInvoice, SfRawEstimate, SfRawCustomer, SfPagedResponse } from './types'

const SF_TOKEN_URL = 'https://api.servicefusion.com/oauth/access_token'
const SF_BASE_URL = 'https://api.servicefusion.com/v1'

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
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 500))

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8_000)

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

export class ServiceFusionProvider implements CrmProvider, AnalyticsCrmProvider {
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
    const results: CrmJob[] = []
    let page = 1

    while (true) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json = (await sfGet('/jobs', {
        'filters[start_date][gte]': fmt(weekStart),
        'filters[start_date][lte]': fmt(weekEnd),
        expand: 'techs_assigned',
        'per-page': '50',
        page: String(page),
      })) as any

      const items: unknown[] = json?.items ?? []

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const job of items as any[]) {
        // Filter to only jobs assigned to this tech
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const techs: any[] = job.techs_assigned ?? []
        if (!techs.some(t => String(t.id) === sfTechId)) continue

        // status is a plain string e.g. "Open Job", "Open Job In Progress", "Job Closed", "Cancelled"
        const statusStr: string = job.status ?? ''
        const lower = statusStr.toLowerCase()

        let status: 'assigned' | 'completed' | null = null
        if (lower.includes('closed')) status = 'completed'
        else if (lower.includes('cancel') || lower.includes('estimate')) status = null
        else status = 'assigned'

        if (!status) continue

        results.push({
          id: String(job.id),
          jobNumber: job.number ?? String(job.id),
          customerName: job.customer_name ?? `SF Job #${job.id}`,
          scheduledDate: (job.start_date ?? fmt(weekStart)).slice(0, 10),
          status,
          statusLabel: statusStr,
        })
      }

      const meta = json?._meta
      if (!meta || page >= (meta.pageCount ?? 1)) break
      page++
    }

    return results
  }

  async listJobStatuses(): Promise<SfRawStatus[]> {
    const json = (await sfGet('/job-statuses', { 'per-page': '200' })) as any
    return (json?.items ?? []).map((s: any) => ({
      id: String(s.id),
      name: s.name ?? '',
      category: s.category ?? null,
    }))
  }

  async listJobCategories(): Promise<SfRawCategory[]> {
    const json = (await sfGet('/job-categories', { 'per-page': '200' })) as any
    return (json?.items ?? []).map((c: any) => ({
      id: String(c.id),
      name: c.name ?? '',
    }))
  }

  async listJobsPaged(page: number, perPage: number, filters: Record<string, string> = {}): Promise<SfPagedResponse<SfRawJob>> {
    const json = (await sfGet('/jobs', {
      ...filters,
      expand: 'techs_assigned',
      'per-page': String(perPage),
      page: String(page),
    })) as any
    return {
      items: json?.items ?? [],
      _meta: json?._meta ?? { totalCount: 0, pageCount: 1, currentPage: page, perPage },
    }
  }

  async listInvoicesPaged(page: number, perPage: number, filters: Record<string, string> = {}): Promise<SfPagedResponse<SfRawInvoice>> {
    const json = (await sfGet('/invoices', {
      ...filters,
      'per-page': String(perPage),
      page: String(page),
    })) as any
    return {
      items: json?.items ?? [],
      _meta: json?._meta ?? { totalCount: 0, pageCount: 1, currentPage: page, perPage },
    }
  }

  async listEstimatesPaged(page: number, perPage: number, filters: Record<string, string> = {}): Promise<SfPagedResponse<SfRawEstimate>> {
    const json = (await sfGet('/estimates', {
      ...filters,
      'per-page': String(perPage),
      page: String(page),
    })) as any
    return {
      items: json?.items ?? [],
      _meta: json?._meta ?? { totalCount: 0, pageCount: 1, currentPage: page, perPage },
    }
  }

  async listCustomersPaged(page: number, perPage: number): Promise<SfPagedResponse<SfRawCustomer>> {
    const json = (await sfGet('/customers', {
      'per-page': String(perPage),
      page: String(page),
    })) as any
    return {
      items: json?.items ?? [],
      _meta: json?._meta ?? { totalCount: 0, pageCount: 1, currentPage: page, perPage },
    }
  }
}
