import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { pingMailchimp, getAudienceInfo } from '@/lib/mailchimp/client'

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile || profile.role !== 'admin' || !profile.is_active) return null
  return user
}

export async function GET() {
  const admin = await requireAdmin()
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const [ping, audience] = await Promise.all([
    pingMailchimp(),
    getAudienceInfo(),
  ])

  return NextResponse.json({
    connected: ping.ok,
    audience: audience ?? null,
    error: ping.error ?? null,
  })
}
