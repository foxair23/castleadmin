import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

// The Navbar's dot: the worst stored health state. Cheap — reads what the last
// evaluation saved rather than re-evaluating.
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ overall: 'green' })
  const { data } = await supabase.from('ops_health_state').select('state').neq('condition', 'checklist:manual')
  const states = (data ?? []).map(r => r.state as string)
  const overall = states.includes('red') ? 'red' : states.includes('amber') ? 'amber' : 'green'
  return NextResponse.json({ overall })
}
