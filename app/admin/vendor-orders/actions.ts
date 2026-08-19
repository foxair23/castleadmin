'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createSfJobForOrder } from '@/lib/vendor-orders/create-sf-job'
import { setAutopilot } from '@/lib/vendor-orders/autopilot'
import { setNudgeSettings, sendNudgeForOrder } from '@/lib/vendor-orders/schedule-nudge'
import { sendDcRequest, setStsSettings } from '@/lib/clopay-sts/dc-request'
import { uploadAttachmentBytes } from '@/lib/clopay-sts/attachments'
import { CLOPAY_STS_STAGES } from '@/lib/clopay-sts/stages'
import { createClient as createAdminClient } from '@supabase/supabase-js'

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

/** Manually send the schedule reminder (email + SMS) for one order — HD Orders
 *  "Send reminder" button. Admin + sales (same as Create SF Job). */
export async function sendNudgeNowAction(orderId: string): Promise<{ ok: boolean; error?: string; warning?: string; channels?: string[] }> {
  if (!(await isAllowed())) return { ok: false, error: 'not authorized' }
  const res = await sendNudgeForOrder(orderId)
  if (res.ok) { revalidatePath('/admin/vendor-orders'); revalidatePath('/sales/hd-orders') }
  return res
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

// ── Clopay STS ─────────────────────────────────────────────────────────────

function revalidateSts() {
  revalidatePath('/admin/vendor-orders/clopay-sts')
  revalidatePath('/sales/hd-orders/clopay-sts')
  revalidatePath('/admin/action-items')
}

function stsDb() {
  return createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

/** Set an STS order's pipeline status (admin + sales). */
export async function setStsStatusAction(orderId: string, stage: string): Promise<{ ok: boolean; error?: string }> {
  if (!(await isAllowed())) return { ok: false, error: 'not authorized' }
  if (!CLOPAY_STS_STAGES.includes(stage as (typeof CLOPAY_STS_STAGES)[number])) return { ok: false, error: 'invalid status' }
  const db = stsDb()
  const { data: cur } = await db.from('vendor_orders').select('status').eq('id', orderId).eq('vendor', 'clopay_sts').maybeSingle()
  if (!cur) return { ok: false, error: 'order not found' }
  const nowIso = new Date().toISOString()
  await db.from('vendor_orders').update({ status: stage, updated_at: nowIso }).eq('id', orderId)
  await db.from('vendor_order_events').insert({ order_id: orderId, event_type: 'status_change', from_value: cur.status, to_value: stage })
  revalidateSts()
  return { ok: true }
}

/** Manually email the DC for one order's details (HD Orders "Request details"). */
export async function sendDcRequestAction(orderId: string): Promise<{ ok: boolean; error?: string }> {
  if (!(await isAllowed())) return { ok: false, error: 'not authorized' }
  const res = await sendDcRequest(orderId)
  if (res.ok) revalidateSts()
  return res
}

/** Upload a PDF/image attachment to an STS order (manual upload). */
export async function uploadStsAttachmentAction(orderId: string, formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'not authorized' }
  const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || !['admin', 'sales'].includes(profile.role ?? '')) return { ok: false, error: 'not authorized' }

  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: 'no file' }
  if (file.size > 26214400) return { ok: false, error: 'file too large (max 25 MB)' }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const res = await uploadAttachmentBytes(orderId, file.name, file.type || 'application/octet-stream', bytes, 'manual', user.id)
  if (!res.ok) return { ok: false, error: res.error }
  revalidateSts()
  return { ok: true }
}

/** Toggle / configure the Clopay STS auto-request to the DC (admin only). */
export async function setStsSettingsAction(enabled: boolean, dcEmail: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'not authorized' }
  const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') return { ok: false, error: 'admin only' }
  await setStsSettings(enabled, dcEmail.trim(), user.id)
  revalidateSts()
  return { ok: true }
}
