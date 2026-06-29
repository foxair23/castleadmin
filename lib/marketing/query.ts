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

  const rows = await fetchAll<{ id: string }>((from, to) => {
    let q = db
      .from('sf_customers')
      .select('id, last_serviced_date')
      .eq('is_deleted', false)
      .order('last_serviced_date', { ascending: false, nullsFirst: false })
    if (dateRange.from) q = q.gte('last_serviced_date', dateRange.from)
    if (dateRange.to) q = q.lte('last_serviced_date', dateRange.to)
    if (sources.length > 0) q = q.in('referral_source', sources)
    if (filters.paymentFilter === 'outstanding') q = q.gt('account_balance', 0)
    return q.range(from, to)
  })

  const ids = rows.map(r => r.id)
  return categorySet ? ids.filter(id => categorySet!.has(id)) : ids
}
