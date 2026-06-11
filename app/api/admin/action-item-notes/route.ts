import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return null
  return user
}

export async function POST(req: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { entity_type, entity_id, note } = body as { entity_type: string; entity_id: string; note: string }
  if (!entity_type || !entity_id) {
    return NextResponse.json({ error: 'entity_type and entity_id required' }, { status: 400 })
  }

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { error } = await db.from('action_item_notes').upsert(
    {
      entity_type,
      entity_id: String(entity_id),
      note: note ?? '',
      updated_at: new Date().toISOString(),
      created_by: user.id,
    },
    { onConflict: 'entity_type,entity_id' }
  )

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
