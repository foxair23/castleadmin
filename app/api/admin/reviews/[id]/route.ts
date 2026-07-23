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
  const { action, customerId, jobId, techUserId } = body as {
    action: 'confirm' | 'skip' | 'manual' | 'unmatch' | 'set_tech'
    customerId?: string
    jobId?: string
    techUserId?: string | null
  }

  if (!['confirm', 'skip', 'manual', 'unmatch', 'set_tech'].includes(action)) {
    return NextResponse.json({ error: 'invalid action' }, { status: 400 })
  }

  if (action === 'manual' && !customerId && !jobId) {
    return NextResponse.json({ error: 'customerId or jobId required for manual action' }, { status: 400 })
  }

  // Pin (or clear) the credited tech directly on the review. Used when the
  // job-derived tech is wrong — e.g. a later site visit was done by a different
  // tech than the one on the job record. techUserId null clears the override and
  // falls back to the job-derived tech.
  if (action === 'set_tech') {
    const { error } = await db()
      .from('google_reviews')
      .update({ matched_tech_user_id: techUserId ?? null })
      .eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  // For a manual match, resolve the customer from the chosen job when only a
  // job was given — the credited tech is derived from matched_job_id, so
  // assigning a specific job is what attributes the review to a tech.
  let manualCustomerId = customerId ?? null
  if (action === 'manual' && jobId && !manualCustomerId) {
    const { data: job } = await db().from('sf_jobs').select('customer_id').eq('id', jobId).single()
    manualCustomerId = (job?.customer_id as string | null) ?? null
  }

  const update =
    action === 'confirm'
      ? { match_status: 'confirmed' }
      : action === 'skip'
      ? {
          match_status:         'skipped',
          matched_customer_id:  null,
          matched_job_id:       null,
          matched_tech_user_id: null,
          match_score:          null,
          match_confidence:     null,
        }
      : action === 'manual'
      ? {
          // A fresh job assignment supersedes any previous tech override, so
          // clear it — the credited tech should follow the newly chosen job
          // unless the admin explicitly overrides again.
          match_status:         'confirmed',
          match_confidence:     'manual',
          matched_customer_id:  manualCustomerId,
          matched_job_id:       jobId ?? null,
          matched_tech_user_id: null,
          match_score:          null,
        }
      : {
          match_status:         'pending_review',
          match_confidence:     null,
          matched_customer_id:  null,
          matched_job_id:       null,
          matched_tech_user_id: null,
          match_score:          null,
        }

  const { error } = await db().from('google_reviews').update(update).eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
