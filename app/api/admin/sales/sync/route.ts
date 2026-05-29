import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { runMailchimpSalesSync } from '@/lib/mailchimp/sales-sync'

export const maxDuration = 60

const RATE_LIMIT_MINUTES = 5

export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, is_active')
    .eq('id', user.id)
    .single()

  if (!profile?.is_active || !['admin', 'sales'].includes(profile.role ?? '')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Rate-limit: no more than one sync per user per 5 minutes
  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  const since = new Date(Date.now() - RATE_LIMIT_MINUTES * 60 * 1000).toISOString()
  const { data: recentRun } = await db
    .from('mc_sync_runs')
    .select('triggered_at')
    .eq('triggered_by_user', user.id)
    .gte('triggered_at', since)
    .limit(1)
    .single()

  if (recentRun) {
    const nextAllowed = new Date(
      new Date(recentRun.triggered_at).getTime() + RATE_LIMIT_MINUTES * 60 * 1000
    )
    const secondsRemaining = Math.ceil((nextAllowed.getTime() - Date.now()) / 1000)
    return NextResponse.json(
      { error: `Please wait ${secondsRemaining}s before syncing again.` },
      { status: 429 }
    )
  }

  try {
    const result = await runMailchimpSalesSync(user.id)
    return NextResponse.json({ ok: true, ...result })
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Sync failed' },
      { status: 500 }
    )
  }
}
