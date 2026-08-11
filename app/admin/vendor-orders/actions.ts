'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createSfJobForOrder } from '@/lib/vendor-orders/create-sf-job'
import { setAutopilot } from '@/lib/vendor-orders/autopilot'
import { setNudgeSettings } from '@/lib/vendor-orders/schedule-nudge'

async function isAllowed(): Promise<boolean> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return false
  const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', user.id).single()
  return !!profile?.is_active && ['admin', 'sales'].includes(profile.role ?? '')
}

/** Create the SF job for one vendor order (manual "Create SF Job" button). */
export async function createSfJobAction(orderId: string): Promise<{ ok: boolean; error?: string; warning?: string }> {
  if (!(await isAllowed())) return { ok: false, error: 'not authorized' }
  const res = await createSfJobForOrder(orderId)
  if (res.ok) { revalidatePath('/admin/vendor-orders'); revalidatePath('/sales/hd-orders') }
  return { ok: res.ok, error: res.error, warning: res.warning }
}

/** Toggle Genie autopilot (admin only). */
export async function setAutopilotAction(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'not authorized' }
  const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') return { ok: false, error: 'admin only' }
  await setAutopilot('genie_thd', enabled, user.id)
  revalidatePath('/admin/vendor-orders'); revalidatePath('/sales/hd-orders')
  return { ok: true }
}

/** Toggle / configure the Genie schedule nudge (admin only). */
export async function setNudgeSettingsAction(enabled: boolean, scheduleUrl: string | null): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'not authorized' }
  const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') return { ok: false, error: 'admin only' }
  await setNudgeSettings('genie_thd', enabled, scheduleUrl, user.id)
  revalidatePath('/admin/vendor-orders'); revalidatePath('/sales/hd-orders')
  return { ok: true }
}
