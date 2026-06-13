import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

export const maxDuration = 60

// ─────────────────────────────────────────────────────────────────────────────
// Revenue diagnostic — paginates ALL sf_jobs and sf_invoices for 2025–2026 and
// computes annual + monthly totals under several candidate definitions so we can
// compare against the Service Fusion "Sales Revenue" report (source of truth) and
// find the definition that matches exactly.
//
// Source-of-truth figures provided by the user:
//   2025 total: $1,080,476.89
//   2026 total (Jan–Jun): $465,007.92
// ─────────────────────────────────────────────────────────────────────────────

const PAGE = 1000

function isValidDate(s: string | null | undefined): s is string {
  if (!s) return false
  // Exclude epoch-zero / garbage dates SF stores for some jobs
  const ym = s.slice(0, 4)
  const year = parseInt(ym, 10)
  return !isNaN(year) && year >= 2000 && year <= 2100
}

async function fetchAll<T>(
  build: (db: SupabaseClient, from: number, to: number) => PromiseLike<{ data: T[] | null }>,
  db: SupabaseClient
): Promise<T[]> {
  const out: T[] = []
  let from = 0
  for (;;) {
    const { data } = await build(db, from, from + PAGE - 1)
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < PAGE) break
    from += PAGE
  }
  return out
}

type Bucket = { count: number; total: number }
function emptyBuckets() {
  return {} as Record<string, Bucket>
}
function add(b: Record<string, Bucket>, key: string, amount: number) {
  if (!b[key]) b[key] = { count: 0, total: 0 }
  b[key].count++
  b[key].total += amount
}
function annual(b: Record<string, Bucket>, year: string): Bucket {
  const out = { count: 0, total: 0 }
  for (const [k, v] of Object.entries(b)) {
    if (k.startsWith(year)) { out.count += v.count; out.total += v.total }
  }
  return out
}
function round(n: number) { return Math.round(n * 100) / 100 }
function summarize(b: Record<string, Bucket>) {
  const months = Object.keys(b).filter(k => k >= '2025' && k <= '2026-12').sort()
  return {
    annual2025: { count: annual(b, '2025').count, total: round(annual(b, '2025').total) },
    annual2026: { count: annual(b, '2026').count, total: round(annual(b, '2026').total) },
    byMonth: months.map(m => ({ month: m, count: b[m].count, total: round(b[m].total) })),
  }
}

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: p } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (p?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // ── Pull ALL sf_jobs in the window (paginated, no truncation) ──────────────
  type JobRow = { closed_at: string | null; end_date: string | null; start_date: string | null; total: number | null; status: string | null; is_deleted: boolean }
  const jobs = await fetchAll<JobRow>((d, from, to) =>
    d.from('sf_jobs')
      .select('closed_at, end_date, start_date, total, status, is_deleted')
      .or('end_date.gte.2025-01-01,closed_at.gte.2025-01-01')
      .range(from, to)
  , db)

  const liveJobs = jobs.filter(j => !j.is_deleted)

  // Candidate A: bucket by end_date, total>0, no status filter
  const A = emptyBuckets()
  // Candidate B: bucket by end_date, status blocklist
  const B = emptyBuckets()
  // Candidate C: bucket by valid closed_at only
  const C = emptyBuckets()
  // Candidate D: bucket by closed_at-if-valid-else-end_date (current dashboard logic)
  const D = emptyBuckets()

  const BLOCK = new Set(['cancelled', 'void', 'voided', 'open', 'pending', 'scheduled'])
  const statusCounts: Record<string, Bucket> = {}

  for (const j of liveJobs) {
    const amt = j.total ?? 0
    const st = (j.status ?? '').trim()
    add(statusCounts, st || '(blank)', amt)

    if (isValidDate(j.end_date) && amt > 0) add(A, j.end_date.slice(0, 7), amt)
    if (isValidDate(j.end_date) && amt > 0 && !BLOCK.has(st.toLowerCase())) add(B, j.end_date.slice(0, 7), amt)
    if (isValidDate(j.closed_at) && amt > 0) add(C, j.closed_at.slice(0, 7), amt)

    const bucketDate = isValidDate(j.closed_at) ? j.closed_at : (isValidDate(j.end_date) ? j.end_date : null)
    if (bucketDate && amt > 0) add(D, bucketDate.slice(0, 7), amt)
  }

  // ── Pull ALL sf_invoices in the window (paginated) ─────────────────────────
  type InvRow = { date: string | null; total: number | null; is_paid: boolean | null; is_deleted: boolean }
  const invoices = await fetchAll<InvRow>((d, from, to) =>
    d.from('sf_invoices')
      .select('date, total, is_paid, is_deleted')
      .gte('date', '2025-01-01')
      .range(from, to)
  , db)
  const liveInv = invoices.filter(i => !i.is_deleted)

  // Candidate E: invoices by date (all)
  const E = emptyBuckets()
  // Candidate F: paid invoices only
  const F = emptyBuckets()
  for (const i of liveInv) {
    const amt = i.total ?? 0
    if (isValidDate(i.date)) {
      add(E, i.date.slice(0, 7), amt)
      if (i.is_paid) add(F, i.date.slice(0, 7), amt)
    }
  }

  // Status breakdown sorted by total desc
  const statusBreakdown = Object.entries(statusCounts)
    .map(([status, v]) => ({ status, count: v.count, total: round(v.total) }))
    .sort((a, b) => b.total - a.total)

  return NextResponse.json({
    sourceOfTruth: { '2025': 1080476.89, '2026_jan_jun': 465007.92 },
    rowCounts: {
      sf_jobs_fetched: jobs.length,
      sf_jobs_live: liveJobs.length,
      sf_invoices_fetched: invoices.length,
      sf_invoices_live: liveInv.length,
    },
    candidates: {
      A_jobs_by_end_date_total_gt_0: summarize(A),
      B_jobs_by_end_date_status_blocklist: summarize(B),
      C_jobs_by_valid_closed_at: summarize(C),
      D_jobs_closed_at_else_end_date_CURRENT: summarize(D),
      E_invoices_by_date_all: summarize(E),
      F_invoices_by_date_paid_only: summarize(F),
    },
    statusBreakdown,
  })
}
