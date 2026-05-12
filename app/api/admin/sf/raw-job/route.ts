import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ServiceFusionProvider } from '@/lib/crm/service-fusion'

export const maxDuration = 30

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: p } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (p?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // Fetch one page of raw SF jobs and return all fields on the first item
  try {
    const sf = new ServiceFusionProvider()
    const result = await sf.listJobsPaged(1, 1)
    const raw = result.items[0] ?? null
    return NextResponse.json({ fields: raw ? Object.keys(raw) : [], sample: raw })
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 })
  }
}
