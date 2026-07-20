import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { sendArAgingReports } from '@/lib/ar-aging/send'

export const maxDuration = 120

// Manual AR-aging send, triggered from the Action Items → Unpaid Jobs tab.
// { onlyMe: true } sends just to the requesting admin (a test run); otherwise
// it goes to every weekly_ar_aging subscriber — identical to the Monday cron.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
  const { data: profile } = await db.from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const onlyMe = body?.onlyMe === true

  const result = await sendArAgingReports(onlyMe ? { onlyUserId: user.id } : undefined)
  return NextResponse.json({ ok: true, ...result })
}
