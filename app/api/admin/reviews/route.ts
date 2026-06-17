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

export async function GET(req: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const page       = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))
  const pageSize   = 25
  const stars      = searchParams.get('stars')       // comma-separated e.g. "1,5"
  const status     = searchParams.get('status')      // match_status filter
  const dateFrom   = searchParams.get('date_from')
  const dateTo     = searchParams.get('date_to')

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  let query = db
    .from('google_reviews')
    .select('id, google_review_id, reviewer_name, star_rating, comment, created_at_google, reply_text, match_status, matched_customer_id, matched_job_id, deleted_at', { count: 'exact' })
    .is('deleted_at', null)
    .order('created_at_google', { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1)

  if (stars) {
    const ratings = stars.split(',').map(s => parseInt(s, 10)).filter(n => n >= 1 && n <= 5)
    if (ratings.length > 0) query = query.in('star_rating', ratings)
  }
  if (status && status !== 'all') query = query.eq('match_status', status)
  if (dateFrom) query = query.gte('created_at_google', dateFrom)
  if (dateTo)   query = query.lte('created_at_google', dateTo + 'T23:59:59Z')

  const { data, error, count } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ reviews: data ?? [], total: count ?? 0, page, pageSize })
}
