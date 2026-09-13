import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { loadMonitorOverview, loadScorecard, loadLiveScans, ourLocation } from '@/lib/rank/scorecard'
import { isRankProviderConfigured } from '@/lib/rank/dataforseo'
import { weekKeyFor } from '@/lib/rank/scan'

export const maxDuration = 60

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') return null
  return user
}

// GET /api/admin/reviews/rankings → everything the Rankings sub-tab shows at once.
export async function GET() {
  if (!await requireAdmin()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const db = createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const overview = await loadMonitorOverview(db)
  const [scorecard, liveScans, { data: places }, { data: pages }] = await Promise.all([
    loadScorecard(db, overview), loadLiveScans(db),
    db.from('rank_places').select('id, name, kind, lat, lng, zips, is_active, sort').order('sort').order('name'),
    db.from('area_pages').select('place_id, url, notes, page_updated_at'),
  ])
  const weekKey = weekKeyFor(new Date())
  // Castle's own pin: first stored result that is us with coordinates, from the newest scans.
  const latestIds = overview.filter(m => m.latest).map(m => m.latest!.id).slice(0, 20)
  const { data: pts } = latestIds.length ? await db.from('rank_scan_points').select('results').in('scan_id', latestIds).limit(200) : { data: [] }
  const us = ourLocation((pts ?? []) as Array<{ results: never[] }>)
  return NextResponse.json({ configured: isRankProviderConfigured(), weekKey, overview, scorecard, liveScans, places: places ?? [], areaPages: pages ?? [], us })
}
