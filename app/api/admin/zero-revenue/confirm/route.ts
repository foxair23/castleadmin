import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

function adminDb() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

// Admin + sales — sales work the Awaiting Revenue tab too.
async function requireStaff() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await adminDb().from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || !['admin', 'sales'].includes(profile.role ?? '')) return null
  return user
}

// Confirm (or un-confirm) that a completed $0 job is a legitimate true-$0 — no
// revenue is coming. { job_id, confirmed } — confirmed:true flags it (removes it
// from the Awaiting Revenue tab, counts it as Confirmed $0 on the dashboard);
// confirmed:false undoes it.
export async function POST(req: NextRequest) {
  const user = await requireStaff()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { job_id, confirmed } = await req.json() as { job_id?: string; confirmed?: boolean }
  if (!job_id) return NextResponse.json({ error: 'job_id required' }, { status: 400 })

  const db = adminDb()
  if (confirmed === false) {
    const { error } = await db.from('zero_revenue_confirmations').delete().eq('sf_job_id', job_id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, confirmed: false })
  }

  const { error } = await db.from('zero_revenue_confirmations').upsert(
    { sf_job_id: job_id, confirmed_by: user.id, confirmed_at: new Date().toISOString() },
    { onConflict: 'sf_job_id' }
  )
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, confirmed: true })
}
