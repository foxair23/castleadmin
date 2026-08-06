import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { runIncrementalSyncForEntity } from '@/lib/sf-mirror/sync-engine'
import { rematchPending } from '@/lib/remittance/engine'

export const maxDuration = 300
export const dynamic = 'force-dynamic'

// On-demand Service Fusion refresh for the remittances screen: pull jobs +
// invoices changed/created in SF recently (e.g. a corrected invoice amount, or a
// new job created to receive a payment), then re-run matching so those lines can
// resolve. Admin-only. Same-origin (session cookie) — /api/remittance/* bypasses
// the login redirect, so the admin check is enforced here.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const started = Date.now()
  try {
    // Bounded so the whole request stays within maxDuration even on a big delta.
    const jobs = await runIncrementalSyncForEntity('jobs', started + 120_000)
    const invoices = await runIncrementalSyncForEntity('invoices', started + 240_000)
    const { updated: rematched } = await rematchPending()
    return NextResponse.json({ ok: true, jobs, invoices, rematched, ms: Date.now() - started })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
