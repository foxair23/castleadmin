import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { requireCommissionAdmin } from '@/lib/commission/admin-auth'
import { refreshCommission } from '@/lib/commission/engine'

export const maxDuration = 300

// POST { sf_job_id, accepted, tech_user_id? } — accept/deny commission on a
// specific job at ANY stage (§3.4 / §8.3).
//
// Deny: marks the job not_accepted, creating the eligibility row first if the
// job isn't completed yet (Sold/Scheduled). Accept: for a completed job, sets
// it back to eligible; for a not-yet-completed job, removes the manual denial
// so it reverts to a normal projection. The decision is preserved across
// recomputes. Recomputes afterward so totals update.
export async function POST(req: NextRequest) {
  const admin = await requireCommissionAdmin()
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { sf_job_id, accepted, tech_user_id } = await req.json()
  if (!sf_job_id || typeof accepted !== 'boolean') {
    return NextResponse.json({ error: 'sf_job_id and accepted required' }, { status: 400 })
  }

  const db = await createServiceClient()
  const now = new Date().toISOString()

  // Look at the job's completion state and any existing eligibility row.
  const [{ data: job }, { data: existing }] = await Promise.all([
    db.from('sf_jobs').select('closed_at, total').eq('id', sf_job_id).maybeSingle(),
    db.from('commission_job_eligibility').select('id').eq('sf_job_id', sf_job_id).maybeSingle(),
  ])
  const isCompleted = !!job?.closed_at

  if (!accepted) {
    // Deny.
    if (existing) {
      const { error } = await db
        .from('commission_job_eligibility')
        .update({ status: 'not_accepted', review_reason: null, resolved_by: admin.id, resolved_at: now, updated_at: now })
        .eq('id', existing.id)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    } else {
      // Not-yet-completed job with no row — create the denial.
      const { error } = await db.from('commission_job_eligibility').insert({
        sf_job_id,
        tech_user_id: tech_user_id ?? null,
        recognition_date: isCompleted ? (job!.closed_at as string).slice(0, 10) : null,
        revenue: job?.total ?? 0,
        revenue_frozen: false,
        status: 'not_accepted',
        resolved_by: admin.id,
        resolved_at: now,
      })
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }
  } else {
    // Accept.
    if (isCompleted) {
      if (existing) {
        const { error } = await db
          .from('commission_job_eligibility')
          .update({ status: 'eligible', review_reason: null, resolved_by: admin.id, resolved_at: now, updated_at: now })
          .eq('id', existing.id)
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      }
      // (No row + completed shouldn't happen; the sync would have created one.)
    } else if (existing) {
      // Not-yet-completed: remove the manual denial → reverts to projection.
      const { error } = await db.from('commission_job_eligibility').delete().eq('id', existing.id)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }
  }

  try {
    await refreshCommission()
  } catch (e) {
    return NextResponse.json({ ok: true, recompute_error: String(e) })
  }
  return NextResponse.json({ ok: true })
}
