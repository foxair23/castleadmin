import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { loadScanDetail } from '@/lib/rank/scorecard'

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') return null
  return user
}

// GET /api/admin/reviews/rankings/scan?id=… → one scan's grid points (compared to the previous scan) and competitors.
export async function GET(req: NextRequest) {
  if (!await requireAdmin()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const db = createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const detail = await loadScanDetail(db, id)
  if (!detail) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(detail)
}
