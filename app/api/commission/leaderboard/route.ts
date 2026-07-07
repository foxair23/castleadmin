import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient, type SupabaseClient } from '@supabase/supabase-js'
import { periodForRecognitionDate } from '@/lib/commission/periods'
import { buildResolver, buildTokenMap, classifyJobWithTokens, extractNoteTokens, type AgentMapping, type AgentOnJob, type TokenMapping } from '@/lib/commission/eligibility'

// GET ?period_start=&period_end= — SALES leaderboard (TRD §9).
//
// This is a SALES board, NOT commission: it credits a rep for new business they
// SOLD in the period (by job creation date), attributed via the agent→tech
// mapping. It is independent of commission eligibility — denied / needs-review /
// not-yet-completed jobs all still count as sales. "Dollars received" is the
// collected portion of those sold jobs.
//
// Visible to all authenticated users; only rank/name/sold/received are returned.

const EXCLUDED_STATUSES = '("Cancelled","Void","Voided")'

async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const PAGE = 1000
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1)
    if (error) throw new Error(JSON.stringify(error))
    if (!data || data.length === 0) break
    out.push(...data)
    if (data.length < PAGE) break
  }
  return out
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const start = req.nextUrl.searchParams.get('period_start')
  const end = req.nextUrl.searchParams.get('period_end')
  if (!start || !end) return NextResponse.json({ error: 'period required' }, { status: 400 })
  const period = periodForRecognitionDate(start)
  if (!period || period.start !== start || period.end !== end) {
    return NextResponse.json({ error: 'invalid period' }, { status: 400 })
  }

  const db: SupabaseClient = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )

  // 1. Agent → tech resolver.
  const { data: maps } = await db
    .from('commission_agent_map')
    .select('tech_user_id, agent_id, agent_first_name, agent_last_name')
  const resolver = buildResolver((maps ?? []) as AgentMapping[])
  const { data: tokenRows } = await db
    .from('commission_note_tokens')
    .select('token, tech_user_id')
  const tokenMap = buildTokenMap((tokenRows ?? []) as TokenMapping[])

  // 2. Jobs SOLD (created) in the period — full day range on created_at_sf.
  const jobs = await fetchAll<{ id: string; total: number | null; tech_notes: string | null; completion_notes: string | null }>((f, t) =>
    db.from('sf_jobs')
      .select('id, total, tech_notes, completion_notes')
      .eq('is_deleted', false)
      .not('status', 'in', EXCLUDED_STATUSES)
      .gte('created_at_sf', `${start}T00:00:00`)
      .lte('created_at_sf', `${end}T23:59:59.999`)
      .order('id', { ascending: true })
      .range(f, t),
  )
  const jobIds = jobs.map(j => j.id)
  const totalById = new Map(jobs.map(j => [j.id, j.total ?? 0]))
  const tokensById = new Map(jobs.map(j => [j.id, extractNoteTokens(j.tech_notes, j.completion_notes)]))
  if (jobIds.length === 0) return NextResponse.json({ rows: [] })

  // 3. Agents per job → resolve the selling rep (single mapped agent only).
  const agentRows = await fetchAll<AgentOnJob & { job_id: string }>((f, t) =>
    db.from('sf_job_agents')
      .select('job_id, agent_id, agent_first_name, agent_last_name')
      .in('job_id', jobIds)
      .order('job_id', { ascending: true })
      .range(f, t),
  )
  const agentsByJob = new Map<string, AgentOnJob[]>()
  for (const a of agentRows) {
    const arr = agentsByJob.get(a.job_id) ?? []
    arr.push(a)
    agentsByJob.set(a.job_id, arr)
  }

  // 4. Collection: jobs with a paid, live invoice.
  const paid = await fetchAll<{ job_id: string | null }>((f, t) =>
    db.from('sf_invoices')
      .select('job_id')
      .eq('is_paid', true).eq('is_deleted', false)
      .in('job_id', jobIds)
      .order('id', { ascending: true })
      .range(f, t),
  )
  const paidJobs = new Set(paid.map(p => p.job_id).filter(Boolean) as string[])

  // 4b. Denied jobs are excluded — a denied job wasn't really a sale.
  const deniedRows = await fetchAll<{ sf_job_id: string }>((f, t) =>
    db.from('commission_job_eligibility')
      .select('sf_job_id')
      .eq('status', 'not_accepted')
      .in('sf_job_id', jobIds)
      .order('sf_job_id', { ascending: true })
      .range(f, t),
  )
  const denied = new Set(deniedRows.map(r => r.sf_job_id))

  // 5. Aggregate per tech (only jobs cleanly attributable to one rep, not denied).
  const byTech = new Map<string, { sold: number; received: number }>()
  for (const jobId of jobIds) {
    if (denied.has(jobId)) continue
    const cls = classifyJobWithTokens(tokensById.get(jobId) ?? [], tokenMap, agentsByJob.get(jobId) ?? [], resolver)
    if (!cls || cls.status !== 'eligible' || !cls.tech_user_id) continue
    const total = totalById.get(jobId) ?? 0
    const cur = byTech.get(cls.tech_user_id) ?? { sold: 0, received: 0 }
    cur.sold += total
    if (paidJobs.has(jobId)) cur.received += total
    byTech.set(cls.tech_user_id, cur)
  }

  const techIds = Array.from(byTech.keys())
  const names = new Map<string, string>()
  if (techIds.length > 0) {
    const { data: profiles } = await db.from('profiles').select('id, full_name').in('id', techIds)
    for (const p of profiles ?? []) names.set(p.id, p.full_name)
  }

  const rows = techIds
    .map(id => ({
      tech_name: names.get(id) ?? 'Unknown',
      dollars_sold: Math.round(byTech.get(id)!.sold * 100) / 100,
      dollars_received: Math.round(byTech.get(id)!.received * 100) / 100,
    }))
    .sort((a, b) => b.dollars_sold - a.dollars_sold)
    .map((row, i) => ({ rank: i + 1, ...row }))

  return NextResponse.json({ rows })
}
