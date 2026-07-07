import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { requireCommissionAdmin } from '@/lib/commission/admin-auth'
import { refreshCommission } from '@/lib/commission/engine'

export const maxDuration = 300

// POST — set (or clear) a technician's commission note token.
// Body: { tech_user_id, token }. Empty/blank token clears it. One token per
// tech; tokens are stored lowercase and must be globally unique.
export async function POST(req: NextRequest) {
  const admin = await requireCommissionAdmin()
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { tech_user_id } = body as { tech_user_id?: string; token?: string }
  const raw = String(body.token ?? '').trim().toLowerCase().replace(/^\$|\$$/g, '')
  if (!tech_user_id) return NextResponse.json({ error: 'tech_user_id required' }, { status: 400 })

  if (raw && !/^[a-z0-9_-]{2,20}$/.test(raw)) {
    return NextResponse.json(
      { error: 'Token must be 2–20 characters: letters, numbers, _ or - (no spaces or $).' },
      { status: 400 },
    )
  }

  const db = await createServiceClient()

  // Uniqueness across techs (case-insensitive).
  if (raw) {
    const { data: clash } = await db
      .from('commission_note_tokens')
      .select('tech_user_id')
      .ilike('token', raw)
      .neq('tech_user_id', tech_user_id)
      .maybeSingle()
    if (clash) return NextResponse.json({ error: `Token "$${raw}$" is already assigned to another technician.` }, { status: 409 })
  }

  // Replace the tech's token (one per tech).
  const { error: delErr } = await db.from('commission_note_tokens').delete().eq('tech_user_id', tech_user_id)
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 })
  if (raw) {
    const { error: insErr } = await db.from('commission_note_tokens').insert({ tech_user_id, token: raw })
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 })
  }

  // Re-resolve eligibility now that attribution rules changed.
  try {
    await refreshCommission()
  } catch (e) {
    return NextResponse.json({ ok: true, recompute_error: String(e) })
  }
  return NextResponse.json({ ok: true })
}
