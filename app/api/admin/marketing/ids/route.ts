import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getMatchingCustomerIds, type MarketingFilters } from '@/lib/marketing/query'

export const maxDuration = 60

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return null
  return user
}

// Resolve a selection to the flat list of customer ids. Used by the client to
// turn "all matching filters" into ids it can then push in small chunks (so no
// single push request runs long enough to hit a gateway timeout).
export async function POST(req: NextRequest) {
  if (!await requireAdmin()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { customerIds, filters, allMatching } = await req.json() as {
    customerIds?: string[]; filters?: MarketingFilters; allMatching?: boolean
  }

  if (allMatching && filters) {
    const db = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
    const ids = await getMatchingCustomerIds(db, filters)
    return NextResponse.json({ ids })
  }
  if (Array.isArray(customerIds)) return NextResponse.json({ ids: customerIds })
  return NextResponse.json({ error: 'Provide customerIds or filters with allMatching' }, { status: 400 })
}
