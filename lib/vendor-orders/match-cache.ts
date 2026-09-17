import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { resolveSfJobMatches } from './sf-match'

// Writes down what the matcher works out, so screens that start from an SF job can join
// instead of re-deriving it. See migration 150 for why this is a cache and not a decision:
// a stored link always outranks it, and nothing that writes into Service Fusion reads it.

export interface MatchCacheResult { looked: number; changed: number; cleared: number }

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

interface Root {
  id: string; parent_order_id: string | null; external_id: string | null
  customer_po: string | null; additional_pos: string[] | null
  customer_name: string | null; email: string | null; phone: string | null
  sf_job_id: string | null; sf_match_excluded_job_ids: string[] | null
  sf_match_job_id: string | null; sf_match_job_number: string | null; sf_match_method: string | null
}

const COLS = 'id, parent_order_id, external_id, customer_po, additional_pos, customer_name, email, phone, sf_job_id, sf_match_excluded_job_ids, sf_match_job_id, sf_match_job_number, sf_match_method'

/** Refresh the cache for one vendor's houses (or all of them). Only rows whose answer
 *  CHANGED are written, so a run that finds nothing new costs nothing in writes. */
export async function refreshMatchCache(vendor?: string, supabase: SupabaseClient = db()): Promise<MatchCacheResult> {
  const out: MatchCacheResult = { looked: 0, changed: 0, cleared: 0 }
  const roots: Root[] = []
  for (let from = 0; ; from += 1000) {
    let q = supabase.from('vendor_orders').select(COLS).is('parent_order_id', null)
    if (vendor) q = q.eq('vendor', vendor)
    const { data } = await q.order('id', { ascending: true }).range(from, from + 999)
    const rows = (data ?? []) as Root[]
    roots.push(...rows)
    if (rows.length < 1000) break
  }
  if (!roots.length) return out
  out.looked = roots.length

  const matches = await resolveSfJobMatches(supabase, roots)
  const now = new Date().toISOString()
  for (const r of roots) {
    const m = matches.get(r.id)
    const jobId = m?.sfJobId ?? null
    const number = m?.sfJobNumber ?? null
    const method = m?.method ?? null
    // Same answer as last time: leave the row (and its updated_at) alone.
    if (r.sf_match_job_id === jobId && r.sf_match_job_number === number && r.sf_match_method === method) continue
    const { error } = await supabase.from('vendor_orders')
      .update({ sf_match_job_id: jobId, sf_match_job_number: number, sf_match_method: method, sf_matched_at: now })
      .eq('id', r.id)
    if (error) continue
    if (jobId) out.changed++; else out.cleared++
  }
  return out
}

/** Store what a page has ALREADY computed. The HD Orders render resolves every match to draw
 *  the table; handing the answers here costs one update per changed row and keeps the cache
 *  warm between cron runs. Best-effort — a failure here must never break a page. */
export async function cacheComputedMatches(
  supabase: SupabaseClient,
  rows: Array<{ id: string; sfJobId: string | null; sfJobNumber: string | null; method: string | null }>,
): Promise<void> {
  if (!rows.length) return
  const ids = rows.map(r => r.id)
  const { data } = await supabase.from('vendor_orders')
    .select('id, sf_match_job_id, sf_match_job_number, sf_match_method').in('id', ids)
  const have = new Map(((data ?? []) as Array<{ id: string; sf_match_job_id: string | null; sf_match_job_number: string | null; sf_match_method: string | null }>).map(r => [r.id, r]))
  const now = new Date().toISOString()
  for (const r of rows) {
    const h = have.get(r.id)
    if (h && h.sf_match_job_id === r.sfJobId && h.sf_match_job_number === r.sfJobNumber && h.sf_match_method === r.method) continue
    await supabase.from('vendor_orders')
      .update({ sf_match_job_id: r.sfJobId, sf_match_job_number: r.sfJobNumber, sf_match_method: r.method, sf_matched_at: now })
      .eq('id', r.id)
  }
}
