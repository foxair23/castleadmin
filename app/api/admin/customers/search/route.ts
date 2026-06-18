import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
  const { data: profile } = await db.from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') return null
  return user
}

export async function GET(req: NextRequest) {
  if (!await requireAdmin()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const q = new URL(req.url).searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) return NextResponse.json({ customers: [] })

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  const { data, error } = await db
    .from('sf_customers')
    .select('id, customer_name, last_serviced_date')
    .ilike('customer_name', `%${q}%`)
    .eq('is_deleted', false)
    .order('customer_name')
    .limit(15)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const customers = data ?? []
  const customerIds = customers.map((c: { id: string }) => c.id)

  // Get most recent closed job per customer as fallback for missing last_serviced_date
  const jobDateMap: Record<string, string> = {}
  if (customerIds.length > 0) {
    const { data: jobs } = await db
      .from('sf_jobs')
      .select('customer_id, closed_at')
      .in('customer_id', customerIds)
      .eq('is_deleted', false)
      .not('closed_at', 'is', null)
      .order('closed_at', { ascending: false })

    for (const j of (jobs ?? []) as Array<{ customer_id: string; closed_at: string }>) {
      if (!jobDateMap[j.customer_id]) jobDateMap[j.customer_id] = j.closed_at
    }
  }

  const result = customers.map((c: { id: string; customer_name: string; last_serviced_date: string | null }) => ({
    id: c.id,
    customer_name: c.customer_name,
    last_serviced_date: c.last_serviced_date ?? jobDateMap[c.id] ?? null,
  }))

  return NextResponse.json({ customers: result })
}
