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

function adminDb() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function PATCH(req: NextRequest) {
  const admin = await requireAdmin()
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { userId, notificationTypeId, isEnabled } = await req.json()
  if (!userId || !notificationTypeId || typeof isEnabled !== 'boolean') {
    return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
  }

  const db = adminDb()

  const { error } = await db
    .from('user_notification_preferences')
    .upsert(
      {
        user_id: userId,
        notification_type_id: notificationTypeId,
        is_enabled: isEnabled,
        updated_at: new Date().toISOString(),
        updated_by_user_id: admin.id,
      },
      { onConflict: 'user_id,notification_type_id' }
    )

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
