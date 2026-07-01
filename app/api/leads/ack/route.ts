import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

// Acknowledge ("Done") an Online Scheduling lead. Used by the in-app Done
// button in the Action Items "Online Scheduling" tab. Requires login; admins
// and sales reps may acknowledge. First acknowledgement wins.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (!['admin', 'sales'].includes(profile?.role ?? '')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let leadId: string | undefined
  try {
    leadId = (await req.json())?.leadId
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!leadId) return NextResponse.json({ error: 'leadId is required' }, { status: 400 })

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
  // Only stamp if not already acknowledged (first ack wins).
  await db.from('scheduler_leads')
    .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: user.id })
    .eq('id', leadId)
    .is('acknowledged_at', null)

  return NextResponse.json({ ok: true })
}
