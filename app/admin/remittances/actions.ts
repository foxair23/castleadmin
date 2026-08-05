'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { rematchPending, aiReviewPending } from '@/lib/remittance/engine'

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return false
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  return profile?.role === 'admin'
}

// Re-run matching on all not-yet-applied remittance lines with the current
// matcher. Admin-only; applied lines are never touched.
export async function rematchAllAction() {
  if (!(await requireAdmin())) return
  await rematchPending()
  revalidatePath('/admin/remittances')
}

// AI review of residual (no_match/ambiguous) lines — advisory suggestions only.
export async function aiReviewAction() {
  if (!(await requireAdmin())) return
  await aiReviewPending()
  revalidatePath('/admin/remittances')
}
