import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: p } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (p?.role !== 'admin') return null
  return user
}

function adminDb() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function GET() {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { data } = await adminDb()
    .from('dashboard_annotations')
    .select('*')
    .order('occurred_on', { ascending: false })

  return NextResponse.json({ annotations: data ?? [] })
}

export async function POST(req: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json()
  if (!body.occurred_on || !body.title?.trim()) {
    return NextResponse.json({ error: 'occurred_on and title are required' }, { status: 400 })
  }

  const { data, error } = await adminDb()
    .from('dashboard_annotations')
    .insert({
      occurred_on: body.occurred_on,
      title: body.title.trim(),
      note: body.note?.trim() || null,
      created_by: user.id,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ annotation: data })
}

export async function PATCH(req: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json()
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { data, error } = await adminDb()
    .from('dashboard_annotations')
    .update({
      occurred_on: body.occurred_on,
      title: body.title?.trim(),
      note: body.note?.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', body.id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ annotation: data })
}

export async function DELETE(req: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  await adminDb().from('dashboard_annotations').delete().eq('id', id)
  return NextResponse.json({ ok: true })
}
