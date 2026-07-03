import type { SupabaseClient } from '@supabase/supabase-js'

// Shared marketing-contact query logic, used by the contacts (paginated display),
// push (send all matching), and csv routes so they always agree on which
// customers a filter set matches.

export interface MarketingFilters {
  recency?: string | null
  dateFrom?: string | null
  dateTo?: string | null
  leadSources?: string[]
  jobCategories?: string[]
  paymentFilter?: string | null // 'outstanding'
}

// Fetch every matching row past PostgREST's 1000-row cap.
async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null }>,
): Promise<T[]> {
  const PAGE = 1000
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data } = await build(from, from + PAGE - 1)
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

export function parseDateRange(
  recency: string | null | undefined,
  dateFrom: string | null | undefined,
  dateTo: string | null | undefined,
): { from: string | null; to: string | null } {
  if (dateFrom || dateTo) return { from: dateFrom ?? null, to: dateTo ?? null }
  if (!recency) return { from: null, to: null }
  if (recency.includes(':')) {
    const [fromStr, toStr] = recency.split(':')
    const fromDays = parseInt(fromStr, 10)
    const toDays = parseInt(toStr, 10)
    if (isNaN(fromDays) || isNaN(toDays)) return { from: null, to: null }
    return {
      from: new Date(Date.now() - toDays * 86_400_000).toISOString().slice(0, 10),
      to: new Date(Date.now() - fromDays * 86_400_000).toISOString().slice(0, 10),
    }
  }
  const days = parseInt(recency, 10)
  if (isNaN(days)) return { from: null, to: null }
  return { from: new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10), to: null }
}

/** Read marketing filters off a URL query string. */
export function filtersFromParams(p: URLSearchParams): MarketingFilters {
  return {
    recency: p.get('recency'),
    dateFrom: p.get('date_from'),
    dateTo: p.get('date_to'),
    leadSources: (p.get('lead_sources') ?? '').split(',').map(s => s.trim()).filter(Boolean),
    jobCategories: (p.get('job_categories') ?? '').split(',').map(s => s.trim()).filter(Boolean),
    paymentFilter: p.get('payment_filter'),
  }
}

/**
 * Every customer id matching the filters, ordered by last service date (desc) —
 * the full set, no row cap. The job-category filter is intersected in-memory so
 * neither the result nor the category set is capped.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getMatchingCustomerIds(db: SupabaseClient<any>, filters: MarketingFilters): Promise<string[]> {
  const dateRange = parseDateRange(filters.recency, filters.dateFrom, filters.dateTo)

  // Category → set of customer ids (full, paginated).
  let categorySet: Set<string> | null = null
  const cats = (filters.jobCategories ?? []).filter(Boolean)
  if (cats.length > 0) {
    const catJobs = await fetchAll<{ customer_id: string }>((from, to) =>
      db.from('sf_jobs')
        .select('customer_id')
        .in('category', cats)
        .eq('is_deleted', false)
        .not('customer_id', 'is', null)
        .order('customer_id', { ascending: true })
        .range(from, to),
    )
    categorySet = new Set(catJobs.map(j => j.customer_id))
    if (categorySet.size === 0) return []
  }

  const sources = (filters.leadSources ?? []).filter(Boolean)
  const noServiceDate = filters.recency === 'none' // customers never serviced

  // Match on the JOB-DERIVED last service date (max sf_jobs.closed_at), not the
  // stale sf_customers.last_serviced_date, via the marketing_customer_ids()
  // function. This is the same source the UI/CSV display, so filter and display
  // always agree. Errors are surfaced (not swallowed) so a missing migration or
  // bad call can't masquerade as "no contacts match".
  const ids: string[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .rpc('marketing_customer_ids', {
        p_date_from: dateRange.from,
        p_date_to: dateRange.to,
        p_none: noServiceDate,
        p_sources: sources.length > 0 ? sources : null,
        p_payment_outstanding: filters.paymentFilter === 'outstanding',
      })
      .range(from, from + PAGE - 1)
    if (error) {
      throw new Error(`marketing_customer_ids failed: ${error.message}. Has migration 047 been applied?`)
    }
    const rows = (data ?? []) as { id: string }[]
    for (const r of rows) ids.push(r.id)
    if (rows.length < PAGE) break
  }

  return categorySet ? ids.filter(id => categorySet!.has(id)) : ids
}

// The later of two 'YYYY-MM-DD' dates (lexical compare is valid for that format),
// ignoring nulls. The effective "last serviced" = later of SF's stored date and
// the job-derived date, matching marketing_customer_ids().
export function laterDate(a: string | null, b: string | null): string | null {
  if (!a) return b ?? null
  if (!b) return a
  return a >= b ? a : b
}

// Job-derived last service date (YYYY-MM-DD) per customer — max sf_jobs.closed_at.
// The single source of truth for "last serviced" shown/exported, so it always
// matches what the filter selects on. Customers with no closed job are absent.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function lastServicedByCustomer(db: SupabaseClient<any>, customerIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const CHUNK = 300
  for (let i = 0; i < customerIds.length; i += CHUNK) {
    const slice = customerIds.slice(i, i + CHUNK)
    if (slice.length === 0) continue
    const rows = await fetchAll<{ customer_id: string; closed_at: string }>((from, to) =>
      db.from('sf_jobs')
        .select('customer_id, closed_at')
        .in('customer_id', slice)
        .eq('is_deleted', false)
        .not('closed_at', 'is', null)
        .order('closed_at', { ascending: false })
        .range(from, to),
    )
    for (const r of rows) {
      // Rows arrive newest-first, so the first per customer is their latest.
      if (!map.has(r.customer_id)) map.set(r.customer_id, r.closed_at.slice(0, 10))
    }
  }
  return map
}
