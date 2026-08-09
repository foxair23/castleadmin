'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createSfJobForOrder } from '@/lib/vendor-orders/create-sf-job'

async function isAdmin(): Promise<boolean> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return false
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  return profile?.role === 'admin'
}

/** Create the SF job for one vendor order (manual "Create SF Job" button). */
export async function createSfJobAction(orderId: string): Promise<{ ok: boolean; error?: string; warning?: string }> {
  if (!(await isAdmin())) return { ok: false, error: 'not authorized' }
  const res = await createSfJobForOrder(orderId)
  if (res.ok) revalidatePath('/admin/vendor-orders')
  return { ok: res.ok, error: res.error, warning: res.warning }
}
