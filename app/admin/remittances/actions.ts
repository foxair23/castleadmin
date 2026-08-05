'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { rematchPending, aiReviewPending, assignLineJob } from '@/lib/remittance/engine'

async function isAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return false
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  return profile?.role === 'admin'
}

// Re-run matching on all not-yet-applied remittance lines with the current
// matcher. Admin-only; applied lines are never touched.
export async function rematchAllAction() {
  if (!(await isAdmin())) return
  await rematchPending()
  revalidatePath('/admin/remittances')
}

// AI review of residual (no_match/ambiguous) lines — advisory suggestions only.
export async function aiReviewAction() {
  if (!(await isAdmin())) return
  await aiReviewPending()
  revalidatePath('/admin/remittances')
}

// Manually allocate a remittance line to a chosen SF job (suggestion or typed
// job number). Returns an error string the UI can show.
export async function assignLineJobAction(lineId: string, opts: { jobId?: string; jobNumber?: string }): Promise<{ ok?: boolean; error?: string }> {
  if (!(await isAdmin())) return { error: 'Not authorized.' }
  const res = await assignLineJob(lineId, opts)
  if (res.ok) revalidatePath('/admin/remittances')
  return res.ok ? { ok: true } : { error: res.error }
}
