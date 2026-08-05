'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { rematchPending } from '@/lib/remittance/engine'

// Re-run matching on all not-yet-applied remittance lines with the current
// matcher. Admin-only; applied lines are never touched.
export async function rematchAllAction() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return

  await rematchPending()
  revalidatePath('/admin/remittances')
}
