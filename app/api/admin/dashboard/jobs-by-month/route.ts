import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient, SupabaseClient } from '@supabase/supabase-js'

export const maxDuration = 60

// Jobs completed in a given month, for the dashboard's bottom detail table.
// Bucketed by closed_at (revenue is recognized on completion, matching the
// Monthly Revenue chart). closed_at reflects Pacific wall-clock, so plain
// YYYY-MM-DD string bounds compare correctly.

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return null
  return user
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null }>): Promise<T[]> {
  const PAGE = 1000
  const out: T[] = []
  let from = 0
  for (;;) {
    const { data } = await build(from, from + PAGE - 1)
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < PAGE) break
    from += PAGE
  }
  return out
}

function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1, 1))
  d.setUTCMonth(d.getUTCMonth() + 1)
  return d.toISOString().slice(0, 7)
}

export async function GET(req: NextRequest) {
  const admin = await requireAdmin()
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const month = req.nextUrl.searchParams.get('month') // 'YYYY-MM'
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: 'month must be YYYY-MM' }, { status: 400 })
  }

  const db: SupabaseClient = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const start = `${month}-01`
  const end = `${nextMonth(month)}-01`

  type JobRow = {
    id: string
    number: string | null
    customer_name: string | null
    source: string | null
    closed_at: string | null
    total: number | null
    due_total: number | null
  }
  const jobs = await fetchAll<JobRow>((from, to) =>
    db.from('sf_jobs')
      .select('id, number, customer_name, source, closed_at, total, due_total')
      .eq('is_deleted', false)
      .not('status', 'in', '("Cancelled","Void","Voided")')
      .gte('closed_at', start)
      .lt('closed_at', end)
      .order('closed_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, to)
  )

  // Attach tech names per job.
  const techsByJob = new Map<string, string[]>()
  const jobIds = jobs.map(j => j.id)
  if (jobIds.length > 0) {
    type TechRow = { job_id: string; tech_first_name: string | null; tech_last_name: string | null }
    const CHUNK = 500
    for (let i = 0; i < jobIds.length; i += CHUNK) {
      const { data } = await db.from('sf_job_techs')
        .select('job_id, tech_first_name, tech_last_name')
        .in('job_id', jobIds.slice(i, i + CHUNK))
      for (const t of (data ?? []) as TechRow[]) {
        const name = [t.tech_first_name, t.tech_last_name].filter(Boolean).join(' ').trim()
        if (!name) continue
        const arr = techsByJob.get(t.job_id) ?? []
        if (!arr.includes(name)) arr.push(name)
        techsByJob.set(t.job_id, arr)
      }
    }
  }

  const rows = jobs.map(j => ({
    id: j.id,
    number: j.number,
    customer: j.customer_name,
    source: j.source,
    closedAt: j.closed_at,
    revenue: j.total ?? 0,
    amountDue: j.due_total ?? 0,
    techs: techsByJob.get(j.id) ?? [],
  }))

  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0)
  const totalDue = rows.reduce((s, r) => s + r.amountDue, 0)

  return NextResponse.json({ month, count: rows.length, totalRevenue, totalDue, rows })
}
