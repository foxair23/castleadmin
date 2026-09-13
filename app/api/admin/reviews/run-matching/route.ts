import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { runIngestPipeline, reviewsDb } from '@/lib/google-reviews/ingest'

export const maxDuration = 60

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await reviewsDb().from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') return null
  return user
}

// "Sync & Match" button: the same pipeline as the cron, with a budget that keeps
// the button responsive. Records a run so the tab's last-sync status reflects
// manual syncs too.
export async function POST() {
  if (!await requireAdmin()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const report = await runIngestPipeline({ trigger: 'admin', budgetMs: 50_000 })
  if (!report.ok) return NextResponse.json({ error: report.errors[0] ?? 'Sync failed', ...report }, { status: 500 })
  return NextResponse.json(report)
}
