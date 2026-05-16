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

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin()
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const body = await req.json()

  const adminClient = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Handle email change
  if (body.new_email) {
    const email = body.new_email.trim().toLowerCase()
    if (!email.includes('@')) {
      return NextResponse.json({ error: 'Invalid email address' }, { status: 400 })
    }
    const { error } = await adminClient.auth.admin.updateUserById(id, { email })
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
    return NextResponse.json({ ok: true, email })
  }

  // Handle password reset
  if (body.new_password) {
    if (body.new_password.length < 6) {
      return NextResponse.json({ error: 'Password must be at least 6 characters' }, { status: 400 })
    }
    const { error } = await adminClient.auth.admin.updateUserById(id, {
      password: body.new_password,
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
    return NextResponse.json({ ok: true })
  }

  // Handle active toggle
  if (typeof body.is_active === 'boolean') {
    const { data: profile, error } = await adminClient
      .from('profiles')
      .update({ is_active: body.is_active })
      .eq('id', id)
      .select()
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
    return NextResponse.json({ profile })
  }

  // Handle weekly bonus update
  if (typeof body.weekly_bonus === 'number') {
    if (body.weekly_bonus < 0) {
      return NextResponse.json({ error: 'Weekly bonus cannot be negative' }, { status: 400 })
    }
    const { data: profile, error } = await adminClient
      .from('profiles')
      .update({ weekly_bonus: body.weekly_bonus })
      .eq('id', id)
      .select()
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
    return NextResponse.json({ profile })
  }

  return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
}
