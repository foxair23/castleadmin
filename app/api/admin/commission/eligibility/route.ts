import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { requireCommissionAdmin } from '@/lib/commission/admin-auth'
import { refreshCommission } from '@/lib/commission/engine'

export const maxDuration = 300

// POST { sf_job_id, accepted } — accept/deny commission on a specific job
// (§3.4 / §8.3). Denying removes it from commission math; accepting restores
// it. The decision is preserved across recomputes (populate honors resolved
// rows). Recomputes afterward so totals update.
export async function POST(req: NextRequest) {
  const admin = await requireCommissionAdmin()
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { sf_job_id, accepted } = await req.json()
  if (!sf_job_id || typeof accepted !== 'boolean') {
    return NextResponse.json({ error: 'sf_job_id and accepted required' }, { status: 400 })
  }

  const db = await createServiceClient()
  const now = new Date().toISOString()
  const { error } = await db
    .from('commission_job_eligibility')
    .update({
      status: accepted ? 'eligible' : 'not_accepted',
      review_reason: null,
      resolved_by: admin.id,
      resolved_at: now,
      updated_at: now,
    })
    .eq('sf_job_id', sf_job_id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  try {
    await refreshCommission()
  } catch (e) {
    return NextResponse.json({ ok: true, recompute_error: String(e) })
  }
  return NextResponse.json({ ok: true })
}
