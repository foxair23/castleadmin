import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ServiceFusionProvider } from '@/lib/crm/service-fusion'

export const maxDuration = 60

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: p } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (p?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const provider = new ServiceFusionProvider()

  const resp = await (provider as any).listJobsPaged(1, 1)
  const raw = resp.items[0] ?? null

  // Log the full structure so field names are visible in Vercel logs
  console.log('SF raw job keys:', raw ? Object.keys(raw) : 'no items')
  console.log('SF raw job sample:', JSON.stringify(raw, null, 2))
  console.log('SF _meta:', JSON.stringify(resp._meta))

  return NextResponse.json({ keys: raw ? Object.keys(raw) : [], sample: raw, meta: resp._meta })
}
