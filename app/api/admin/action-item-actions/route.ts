import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { ACTION_TAB_CONFIG, todayPT } from '@/lib/action-items/config'

// POST — record the tab's (single) action on an item and set its follow-up
// date. Body: { tab, entity_id }. Pressing again overwrites the row and
// restarts the follow-up clock. Admins and sales.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (!['admin', 'sales'].includes(profile?.role ?? '')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: { tab?: string; entity_id?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const cfg = body.tab ? ACTION_TAB_CONFIG[body.tab] : undefined
  if (!cfg || !body.entity_id) {
    return NextResponse.json({ error: 'tab and entity_id required' }, { status: 400 })
  }

  // follow_up_on = today (PT) + the tab's cadence.
  const [y, m, d] = todayPT().split('-').map(Number)
  const due = new Date(Date.UTC(y, m - 1, d + cfg.days)).toISOString().slice(0, 10)

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
  const { error } = await db.from('action_item_actions').upsert(
    {
      entity_type: cfg.entity,
      entity_id: body.entity_id,
      action_label: cfg.button,
      actioned_by: user.id,
      actioned_at: new Date().toISOString(),
      follow_up_on: due,
    },
    { onConflict: 'entity_type,entity_id' },
  )
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, follow_up_on: due })
}
