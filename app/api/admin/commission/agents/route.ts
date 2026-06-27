import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { requireCommissionAdmin } from '@/lib/commission/admin-auth'
import { refreshCommission } from '@/lib/commission/engine'

export const maxDuration = 300

interface AgentRow {
  agent_id: string | null
  agent_first_name: string | null
  agent_last_name: string | null
}

function identityKey(a: AgentRow): string {
  return a.agent_id ?? `name:${(a.agent_first_name ?? '').toLowerCase()}|${(a.agent_last_name ?? '').toLowerCase()}`
}

// GET — distinct agents seen on jobs (with job counts), current mappings, and
// the technician list to map them to (§3.2).
export async function GET() {
  const admin = await requireCommissionAdmin()
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = await createServiceClient()

  const [{ data: agentRows }, { data: maps }, { data: techs }] = await Promise.all([
    db.from('sf_job_agents').select('agent_id, agent_first_name, agent_last_name'),
    db.from('commission_agent_map').select('id, tech_user_id, agent_id, agent_first_name, agent_last_name'),
    db.from('profiles').select('id, full_name').eq('role', 'technician').eq('is_active', true).order('full_name'),
  ])

  // Distinct agents with job counts.
  const counts = new Map<string, { agent: AgentRow; job_count: number }>()
  for (const r of (agentRows ?? []) as AgentRow[]) {
    const k = identityKey(r)
    const cur = counts.get(k)
    if (cur) cur.job_count++
    else counts.set(k, { agent: r, job_count: 1 })
  }

  // Map identity → tech.
  const mapByIdentity = new Map<string, string>()
  for (const m of (maps ?? []) as Array<{ tech_user_id: string } & AgentRow>) {
    mapByIdentity.set(identityKey(m), m.tech_user_id)
  }

  const agents = Array.from(counts.values())
    .map(({ agent, job_count }) => ({
      agent_id: agent.agent_id,
      agent_first_name: agent.agent_first_name,
      agent_last_name: agent.agent_last_name,
      job_count,
      tech_user_id: mapByIdentity.get(identityKey(agent)) ?? null,
    }))
    .sort((a, b) => b.job_count - a.job_count)

  return NextResponse.json({ agents, techs: techs ?? [] })
}

// POST — set or clear the mapping for a single agent. A null/empty
// tech_user_id clears it. Recomputes commission afterward so eligibility
// re-resolves immediately.
export async function POST(req: NextRequest) {
  const admin = await requireCommissionAdmin()
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { agent_id, agent_first_name, agent_last_name, tech_user_id } = body as {
    agent_id: string | null
    agent_first_name: string | null
    agent_last_name: string | null
    tech_user_id: string | null
  }

  if (!agent_id && !(agent_first_name && agent_last_name)) {
    return NextResponse.json({ error: 'Agent identity required' }, { status: 400 })
  }

  const db = await createServiceClient()

  // Find an existing mapping for this agent identity (by id when present).
  const finder = db.from('commission_agent_map').select('id')
  const { data: existing } = agent_id
    ? await finder.eq('agent_id', agent_id).maybeSingle()
    : await finder
        .is('agent_id', null)
        .ilike('agent_first_name', agent_first_name!)
        .ilike('agent_last_name', agent_last_name!)
        .maybeSingle()

  if (!tech_user_id) {
    // Clear mapping.
    if (existing) {
      const { error } = await db.from('commission_agent_map').delete().eq('id', existing.id)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }
  } else if (existing) {
    const { error } = await db
      .from('commission_agent_map')
      .update({ tech_user_id, updated_at: new Date().toISOString() })
      .eq('id', existing.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  } else {
    const { error } = await db.from('commission_agent_map').insert({
      tech_user_id, agent_id, agent_first_name, agent_last_name,
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Re-resolve eligibility now that the mapping changed.
  try {
    await refreshCommission()
  } catch (e) {
    // Mapping saved; surface recompute issues without failing the save.
    return NextResponse.json({ ok: true, recompute_error: String(e) })
  }

  return NextResponse.json({ ok: true })
}
