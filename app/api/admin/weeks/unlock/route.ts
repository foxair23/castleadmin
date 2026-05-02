import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, is_active')
    .eq('id', user.id)
    .single()
  if (!profile || profile.role !== 'admin' || !profile.is_active) return null
  return user
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin()
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { tech_id, week_start_date, lock } = await req.json()
  if (!tech_id || !week_start_date) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  const service = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  if (lock) {
    // Re-lock: delete the unlocked record entirely (tech never resubmitted)
    const { error } = await service
      .from('week_submissions')
      .delete()
      .eq('tech_id', tech_id)
      .eq('week_start_date', week_start_date)
      .is('submitted_at', null)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ unlocked: false })
  }

  // Unlock: upsert a record with submitted_at = null and admin_unlocked = true
  const { error } = await service
    .from('week_submissions')
    .upsert(
      { tech_id, week_start_date, submitted_at: null, admin_unlocked: true },
      { onConflict: 'tech_id,week_start_date' }
    )
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ unlocked: true })
}
