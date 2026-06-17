import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

function db() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await db()
    .from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') return null
  return user
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!await requireAdmin()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const body = await req.json()
  const { action, customerId } = body as { action: 'confirm' | 'skip' | 'manual' | 'unmatch'; customerId?: string }

  if (!['confirm', 'skip', 'manual', 'unmatch'].includes(action)) {
    return NextResponse.json({ error: 'invalid action' }, { status: 400 })
  }

  if (action === 'manual' && !customerId) {
    return NextResponse.json({ error: 'customerId required for manual action' }, { status: 400 })
  }

  const update =
    action === 'confirm'
      ? { match_status: 'confirmed' }
      : action === 'skip'
      ? {
          match_status:        'skipped',
          matched_customer_id: null,
          matched_job_id:      null,
          match_score:         null,
          match_confidence:    null,
        }
      : action === 'manual'
      ? {
          match_status:        'confirmed',
          match_confidence:    'manual',
          matched_customer_id: customerId,
          matched_job_id:      null,
          match_score:         null,
        }
      : {
          match_status:        'pending_review',
          match_confidence:    null,
          matched_customer_id: null,
          matched_job_id:      null,
          match_score:         null,
        }

  const { error } = await db().from('google_reviews').update(update).eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
