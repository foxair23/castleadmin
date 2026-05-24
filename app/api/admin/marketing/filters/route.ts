import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return null
  return user
}

export async function GET() {
  const admin = await requireAdmin()
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const [{ data: sourcesData }, { data: categoriesData }] = await Promise.all([
    db.from('sf_sources').select('id, name').eq('is_deleted', false).order('name'),
    db.from('sf_job_categories').select('id, name').eq('is_deleted', false).order('name'),
  ])

  return NextResponse.json({
    leadSources: (sourcesData ?? []).map(s => ({ id: String(s.id), name: s.name })),
    jobCategories: (categoriesData ?? []).map(c => ({ id: String(c.id), name: c.name })),
  })
}
