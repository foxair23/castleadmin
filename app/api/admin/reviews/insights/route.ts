import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { loadInsights } from '@/lib/reputation/insights'
import { loadReputationSettings } from '@/lib/reputation/settings'
import { ptWallToUtc, addPtDays, ptDateKey } from '@/lib/reputation/pt-time'

export const maxDuration = 60

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') return null
  return user
}

// GET /api/admin/reviews/insights?from=YYYY-MM-DD&to=YYYY-MM-DD (PT calendar days, inclusive)
export async function GET(req: NextRequest) {
  if (!await requireAdmin()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { searchParams } = new URL(req.url)
  const today = ptDateKey(new Date())
  const to = /^\d{4}-\d{2}-\d{2}$/.test(searchParams.get('to') ?? '') ? searchParams.get('to')! : today
  const from = /^\d{4}-\d{2}-\d{2}$/.test(searchParams.get('from') ?? '') ? searchParams.get('from')! : addPtDays(to, -29)
  if (from > to) return NextResponse.json({ error: '"from" must be on or before "to"' }, { status: 400 })
  const db = createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const settings = await loadReputationSettings(db)
  const insights = await loadInsights(db, { fromIso: ptWallToUtc(from, 0).toISOString(), toIso: ptWallToUtc(addPtDays(to, 1), 0).toISOString() }, settings.photo_min_score)
  return NextResponse.json({ from, to, threshold: settings.photo_min_score, insights })
}
