import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { loadKeywordCompetitors } from '@/lib/rank/scorecard'

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') return null
  return user
}

// GET /api/admin/reviews/rankings/competitors?keyword=… → who holds the top spots across every monitored place.
export async function GET(req: NextRequest) {
  if (!await requireAdmin()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const keyword = new URL(req.url).searchParams.get('keyword')?.trim().toLowerCase()
  if (!keyword) return NextResponse.json({ error: 'keyword required' }, { status: 400 })
  const db = createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return NextResponse.json(await loadKeywordCompetitors(db, keyword))
}
