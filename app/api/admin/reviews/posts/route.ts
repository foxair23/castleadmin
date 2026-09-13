import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { PHOTO_SELECT } from '@/lib/reputation/photos'

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') return null
  return user
}

// Profile posts for the Posts sub-tab: each post with its job facts and every
// photo of that job (scores and reasons included) so a person can swap photos.
export async function GET(req: NextRequest) {
  if (!await requireAdmin()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { searchParams } = new URL(req.url)
  const status = searchParams.get('status') ?? 'draft'
  const db = createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  let q = db.from('gbp_posts').select('*').order('created_at', { ascending: false }).limit(100)
  if (status === 'needs_approval') q = q.eq('status', 'draft')
  else if (status === 'scheduled') q = q.in('status', ['approved', 'scheduled'])
  else if (status === 'published') q = q.eq('status', 'published')
  else if (status === 'closed') q = q.in('status', ['skipped', 'failed'])
  else if (status !== 'all') q = q.eq('status', status)
  const { data: posts, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const rows = (posts ?? []) as Array<Record<string, unknown> & { sf_job_id: string }>
  const jobIds = [...new Set(rows.map(r => r.sf_job_id))]
  const [{ data: jobs }, { data: photos }, { count: needsApproval }] = await Promise.all([
    jobIds.length ? db.from('sf_jobs').select('id, number, category, city, work_completed_at, description').in('id', jobIds) : Promise.resolve({ data: [] }),
    jobIds.length ? db.from('job_photos').select(PHOTO_SELECT).in('sf_job_id', jobIds).order('created_at', { ascending: true }) : Promise.resolve({ data: [] }),
    db.from('gbp_posts').select('id', { count: 'exact', head: true }).eq('status', 'draft'),
  ])
  const jobMap = new Map(((jobs ?? []) as Array<{ id: string }>).map(j => [j.id, j]))
  const photoMap = new Map<string, unknown[]>()
  for (const p of (photos ?? []) as Array<{ sf_job_id: string }>) photoMap.set(p.sf_job_id, [...(photoMap.get(p.sf_job_id) ?? []), p])
  return NextResponse.json({
    posts: rows.map(r => ({ ...r, job: jobMap.get(r.sf_job_id) ?? null, photos: photoMap.get(r.sf_job_id) ?? [] })),
    needsApproval: needsApproval ?? 0,
  })
}
