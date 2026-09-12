import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as adminClient } from '@supabase/supabase-js'
import { sfMirrorGet } from '@/lib/sf-mirror/client'

export const dynamic = 'force-dynamic'

// Diagnostic for the e-sign timing rule: one job, live from Service Fusion, with its
// visits expanded — so a site check and an install on the same job can be told apart.
// Read-only (GET-only mirror client). Admin session required.
// /api/admin/esign/job-visits?number=1020256603[&number=…]
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const numbers = req.nextUrl.searchParams.getAll('number').flatMap(n => n.split(/[,\s]+/)).map(n => n.replace(/\D/g, '')).filter(Boolean).slice(0, 10)
  if (!numbers.length) return NextResponse.json({ error: 'pass ?number=<SF job number> (repeatable)' }, { status: 400 })
  const db = adminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const { data: jobs } = await db.from('sf_jobs').select('id, number, status, sub_status, category, start_date, end_date, closed_at').in('number', numbers)

  const out: Record<string, unknown> = {}
  for (const n of numbers) {
    const j = (jobs ?? []).find(x => String(x.number) === n)
    if (!j) { out[n] = { error: 'not in the mirror' }; continue }
    try {
      const raw = await sfMirrorGet(`/jobs/${encodeURIComponent(String(j.id))}`, { expand: 'visits,visits.techs_assigned,techs_assigned' }) as Record<string, unknown>
      const job = (raw && typeof raw === 'object' && 'items' in raw ? (raw.items as unknown[])[0] : raw) as Record<string, unknown>
      const visits = Array.isArray(job?.visits) ? (job.visits as Array<Record<string, unknown>>) : []
      out[n] = {
        mirror: j,
        live: { status: job?.status, sub_status: job?.sub_status, category: job?.category, start_date: job?.start_date, end_date: job?.end_date, completed_date: job?.completed_date, closed_at: job?.closed_at, description: job?.description },
        visit_count: visits.length,
        // Every field SF puts on a visit, untouched, so the naming/date/completion fields can be seen.
        visits,
      }
    } catch (e) {
      out[n] = { mirror: j, error: e instanceof Error ? e.message : String(e) }
    }
  }
  return NextResponse.json(out, { headers: { 'Cache-Control': 'no-store' } })
}
