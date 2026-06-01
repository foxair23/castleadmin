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

// GET /api/admin/rates/[id] — count of referenced pay records
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!await requireAdmin()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const { count } = await db()
    .from('job_work_items')
    .select('id', { count: 'exact', head: true })
    .eq('job_type_id', id)
  return NextResponse.json({ count: count ?? 0 })
}

// DELETE /api/admin/rates/[id] — force-delete, removing referenced work items and recalculating job totals
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!await requireAdmin()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const admin = db()

  // Find jobs that will be affected
  const { data: affectedItems } = await admin
    .from('job_work_items')
    .select('job_id, calculated_pay')
    .eq('job_type_id', id)

  const affectedJobIds = [...new Set((affectedItems ?? []).map(i => i.job_id))]

  // Delete the work items
  await admin.from('job_work_items').delete().eq('job_type_id', id)

  // Recalculate total_pay on each affected job
  if (affectedJobIds.length > 0) {
    const { data: remaining } = await admin
      .from('job_work_items')
      .select('job_id, calculated_pay')
      .in('job_id', affectedJobIds)

    const totals: Record<string, number> = {}
    for (const jobId of affectedJobIds) totals[jobId] = 0
    for (const item of remaining ?? []) totals[item.job_id] += Number(item.calculated_pay)

    await Promise.all(
      Object.entries(totals).map(([jobId, total]) =>
        admin.from('jobs').update({ total_pay: total }).eq('id', jobId)
      )
    )
  }

  // Now delete the job type
  const { error } = await admin.from('job_types').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, removedItems: affectedItems?.length ?? 0 })
}
