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

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 7_000)

  let resp: Response
  try {
    resp = await fetch(SF_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }

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

export async function getToken(): Promise<string> {
  return (await getCachedToken()) ?? (await fetchNewToken())
}

async function sfPost(path: string, body: unknown): Promise<unknown> {
  const token = await getToken()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const resp = await fetch(`${SF_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (resp.status === 429) throw new Error('Service Fusion is busy — please try again in a moment.')
    if (!resp.ok) throw new Error(`Service Fusion API error (${resp.status}): ${await resp.text()}`)
    return resp.json()
  } finally {
    clearTimeout(timeout)
  }
}

async function sfPut(path: string, body: unknown): Promise<unknown> {
  const token = await getToken()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const resp = await fetch(`${SF_BASE_URL}${path}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (resp.status === 429) throw new Error('Service Fusion is busy — please try again in a moment.')
    if (!resp.ok) throw new Error(`Service Fusion API error (${resp.status}): ${await resp.text()}`)
    return resp.json()
  } finally {
    clearTimeout(timeout)
  }
}

export { sfPost, sfGet, sfPut }

async function sfGet(path: string, params?: Record<string, string>): Promise<unknown> {
  const token = await getToken()
  const url = new URL(`${SF_BASE_URL}${path}`)
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 7_000)

  try {
    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
    })
    if (resp.status === 429) throw new Error('Service Fusion is busy — please try again in a moment.')
    if (!resp.ok) throw new Error(`Service Fusion API error (${resp.status}): ${await resp.text()}`)
    return resp.json()
  } finally {
    clearTimeout(timeout)
  }
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
    const weekStartStr = fmt(weekStart)
    const weekEndStr = fmt(weekEnd)

    // Widen the job-level date filter so we catch jobs whose SF start_date
    // differs from their visit dates (e.g. jobs created last week with visits
    // this week, or jobs "scheduled" next week whose visits fall this week).
    // We then filter visits to [weekStart, weekEnd] on our side.
    const fetchFrom = fmt(new Date(weekStart.getTime() - 30 * 86400_000))
    const fetchTo   = fmt(new Date(weekEnd.getTime()   + 14 * 86400_000))

    const results: CrmJob[] = []
    let page = 1

    while (true) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json = (await sfGet('/jobs', {
        'filters[start_date][gte]': fetchFrom,
        'filters[start_date][lte]': fetchTo,
        expand: 'visits,visits.techs_assigned,techs_assigned,items',
        'per-page': '50',
        page: String(page),
      })) as any

      const items: unknown[] = json?.items ?? []

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const job of items as any[]) {
        const statusStr: string = job.status ?? ''
        const lower = statusStr.toLowerCase()

        let status: 'assigned' | 'completed' | null = null
        if (lower.includes('closed')) status = 'completed'
        else if (lower.includes('cancel') || lower.includes('estimate')) status = null
        else status = 'assigned'

        if (!status) continue

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawItems: any[] = job.items ?? job.line_items ?? []
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mappedItems = rawItems.map((item: any) => ({
          name: item.name ?? item.product_name ?? item.item_name ?? null,
          description: item.description ?? null,
          quantity: item.quantity != null ? parseFloat(String(item.quantity)) : null,
          unit_price: item.unit_price ?? item.price ?? item.rate ?? null,
        }))

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const visits: any[] = Array.isArray(job.visits) ? job.visits : []

        if (visits.length === 0) {
          // No visits returned — fall back to job-level tech assignment.
          // Only include if the job's own start_date falls within the week.
          const jobDate = (job.start_date ?? '').slice(0, 10)
          if (jobDate < weekStartStr || jobDate > weekEndStr) continue
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const jobTechs: any[] = job.techs_assigned ?? []
          if (!jobTechs.some((t: any) => String(t.id) === sfTechId)) continue
          results.push({
            id: String(job.id),
            jobNumber: job.number ?? String(job.id),
            customerName: job.customer_name ?? `SF Job #${job.id}`,
            scheduledDate: jobDate || fmt(weekStart),
            status,
            statusLabel: statusStr,
            description: job.description ?? null,
            items: mappedItems,
            visitIndex: 1,
            visitTotal: 1,
            visitNotes: null,
          })
          continue
        }

        // Only include visits whose date falls within the requested week.
        const weekVisits = visits.filter((v: any) => {
          const d = (v.start_date ?? '').slice(0, 10)
          return d >= weekStartStr && d <= weekEndStr
        })

        if (weekVisits.length === 0) {
          // Visits exist in SF but none fall in this week — fall back to the
          // job's own start_date and job-level tech assignment, same as the
          // no-visits path above. This handles the case where a site visit is
          // scheduled outside this week but the original job date is this week.
          const jobDate = (job.start_date ?? '').slice(0, 10)
          if (jobDate < weekStartStr || jobDate > weekEndStr) continue
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const jobTechs: any[] = job.techs_assigned ?? []
          if (!jobTechs.some((t: any) => String(t.id) === sfTechId)) continue
          results.push({
            id: String(job.id),
            jobNumber: job.number ?? String(job.id),
            customerName: job.customer_name ?? `SF Job #${job.id}`,
            scheduledDate: jobDate,
            status,
            statusLabel: statusStr,
            description: job.description ?? null,
            items: mappedItems,
            visitIndex: 1,
            visitTotal: 1,
            visitNotes: null,
          })
          continue
        }

        const visitTotal = weekVisits.length

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        weekVisits.forEach((visit: any, idx: number) => {
          // A tech qualifies for a visit if they appear at the visit level OR
          // the job level. This ensures the job-level tech still gets credit
          // even when a different tech is explicitly assigned to a site visit.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const visitTechs: any[] = visit.techs_assigned?.length > 0 ? visit.techs_assigned : []
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const jobTechs: any[] = job.techs_assigned ?? []
          const eligibleTechs = visitTechs.length > 0 ? [...visitTechs, ...jobTechs] : jobTechs
          if (!eligibleTechs.some((t: any) => String(t.id) === sfTechId)) return
          results.push({
            id: String(job.id),
            jobNumber: job.number ?? String(job.id),
            customerName: job.customer_name ?? `SF Job #${job.id}`,
            scheduledDate: visit.start_date.slice(0, 10),
            status,
            statusLabel: statusStr,
            description: visit.notes_for_techs ?? job.description ?? null,
            items: mappedItems,
            visitIndex: idx + 1,
            visitTotal,
            visitNotes: visit.notes_for_techs ?? null,
          })
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
