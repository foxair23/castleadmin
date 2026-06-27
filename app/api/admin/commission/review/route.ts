import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { requireCommissionAdmin } from '@/lib/commission/admin-auth'
import { refreshCommission } from '@/lib/commission/engine'

export const maxDuration = 300

// POST — resolve a "needs review" commission job (§8.2). Actions:
//   { action: 'credit', eligibility_id, tech_user_id }
//       → credit a specific tech (multiple-agents resolved by picking one).
//   { action: 'not_accepted', eligibility_id }
//       → drop the job from commission.
//   { action: 'map', agent_id, agent_first_name, agent_last_name, tech_user_id }
//       → map the agent to a tech (resolves an unmapped-agent job on recompute).
// Each path recomputes commission so the queue updates immediately.
export async function POST(req: NextRequest) {
  const admin = await requireCommissionAdmin()
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const db = await createServiceClient()
  const now = new Date().toISOString()

  if (body.action === 'credit') {
    const { eligibility_id, tech_user_id } = body
    if (!eligibility_id || !tech_user_id) {
      return NextResponse.json({ error: 'eligibility_id and tech_user_id required' }, { status: 400 })
    }
    const { error } = await db
      .from('commission_job_eligibility')
      .update({
        tech_user_id, status: 'eligible', review_reason: null,
        resolved_by: admin.id, resolved_at: now, updated_at: now,
      })
      .eq('id', eligibility_id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  } else if (body.action === 'not_accepted') {
    const { eligibility_id } = body
    if (!eligibility_id) return NextResponse.json({ error: 'eligibility_id required' }, { status: 400 })
    const { error } = await db
      .from('commission_job_eligibility')
      .update({
        status: 'not_accepted', review_reason: null,
        resolved_by: admin.id, resolved_at: now, updated_at: now,
      })
      .eq('id', eligibility_id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  } else if (body.action === 'map') {
    const { agent_id, agent_first_name, agent_last_name, tech_user_id } = body
    if (!tech_user_id || (!agent_id && !(agent_first_name && agent_last_name))) {
      return NextResponse.json({ error: 'agent + tech_user_id required' }, { status: 400 })
    }
    // Upsert mapping (manual: partial unique indexes don't play well with onConflict).
    const finder = db.from('commission_agent_map').select('id')
    const { data: existing } = agent_id
      ? await finder.eq('agent_id', agent_id).maybeSingle()
      : await finder.is('agent_id', null).ilike('agent_first_name', agent_first_name).ilike('agent_last_name', agent_last_name).maybeSingle()
    if (existing) {
      const { error } = await db.from('commission_agent_map').update({ tech_user_id, updated_at: now }).eq('id', existing.id)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    } else {
      const { error } = await db.from('commission_agent_map').insert({ tech_user_id, agent_id, agent_first_name, agent_last_name })
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }
  } else {
    return NextResponse.json({ error: `Unknown action: ${body.action}` }, { status: 400 })
  }

  try {
    await refreshCommission()
  } catch (e) {
    return NextResponse.json({ ok: true, recompute_error: String(e) })
  }
  return NextResponse.json({ ok: true })
}
