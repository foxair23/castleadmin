import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await supabase
    .from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile || profile.role !== 'admin' || !profile.is_active) return null
  return user
}

export async function PATCH(req: NextRequest) {
  const admin = await requireAdmin()
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { tech_id, sf_technician_id } = await req.json()
  if (!tech_id) return NextResponse.json({ error: 'tech_id required' }, { status: 400 })

  const service = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { error } = await service
    .from('profiles')
    .update({ sf_technician_id: sf_technician_id || null })
    .eq('id', tech_id)
    .eq('role', 'technician')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
