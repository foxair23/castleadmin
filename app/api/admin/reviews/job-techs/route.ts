import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { ServiceFusionProvider } from '@/lib/crm/service-fusion'

export const maxDuration = 30

function admin() {
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
  const { data: profile } = await admin()
    .from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') return null
  return user
}

// The techs who actually worked a given job, visit by visit, pulled live from
// Service Fusion (the mirror only stores job-level techs). Each is mapped to its
// app account via profiles.sf_technician_id so the reviews UI can pin the real
// site-visit tech as the credited tech. ?jobId=<sf_jobs.id, i.e. the SF internal
// job id — not the display number>.
export async function GET(req: NextRequest) {
  if (!await requireAdmin()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const params = new URL(req.url).searchParams
  let jobId = params.get('jobId')?.trim() || ''
  // Backward-compatible: an older client bundle may still send ?number= (the
  // display number). Resolve it to the SF job id so a stale cached client
  // doesn't break the picker.
  const number = params.get('number')?.trim()
  if (!jobId && number) {
    const { data: job } = await admin()
      .from('sf_jobs').select('id').eq('number', number).eq('is_deleted', false).limit(1).maybeSingle()
    jobId = (job?.id as string | undefined) ?? ''
  }
  if (!jobId) return NextResponse.json({ error: 'jobId or number required' }, { status: 400 })

  let sfTechs: Array<{ sfTechId: string; name: string; lastVisitDate: string | null; isJobLevel: boolean }>
  try {
    sfTechs = await new ServiceFusionProvider().getJobVisitTechs(jobId)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load job visits from Service Fusion' },
      { status: 502 }
    )
  }

  // Map SF tech ids to app accounts.
  const sfIds = [...new Set(sfTechs.map(t => t.sfTechId))]
  const userBySfId: Record<string, { id: string; full_name: string | null }> = {}
  if (sfIds.length > 0) {
    const { data: profiles } = await admin()
      .from('profiles')
      .select('id, full_name, sf_technician_id')
      .in('sf_technician_id', sfIds)
    for (const p of (profiles ?? []) as Array<{ id: string; full_name: string | null; sf_technician_id: string | null }>) {
      if (p.sf_technician_id) userBySfId[p.sf_technician_id] = { id: p.id, full_name: p.full_name }
    }
  }

  const techs = sfTechs.map(t => {
    const mapped = userBySfId[t.sfTechId] ?? null
    return {
      sfTechId:      t.sfTechId,
      name:          mapped?.full_name || t.name,
      lastVisitDate: t.lastVisitDate,
      isJobLevel:    t.isJobLevel,
      userId:        mapped?.id ?? null,
    }
  })

  return NextResponse.json({ techs })
}
