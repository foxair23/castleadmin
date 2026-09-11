'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createClient as adminClient } from '@supabase/supabase-js'
import { enqueueExtensionCommand } from '@/lib/ops/extension-report'

// Health page actions: queue a command for the office extension, confirm the manual
// checklist. Admin-only.
async function admin(): Promise<{ id: string; name: string | null } | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await supabase.from('profiles').select('role, is_active, full_name').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') return null
  return { id: user.id, name: (profile.full_name as string | null) ?? null }
}
const db = () => adminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

export async function sendCommandAction(kind: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const u = await admin()
  if (!u) return { ok: false, error: 'admin only' }
  const r = await enqueueExtensionCommand(kind, args, u.id)
  revalidatePath('/admin/ops')
  return r
}

export async function confirmManualChecklistAction(confirmed: boolean): Promise<{ ok: boolean; error?: string }> {
  const u = await admin()
  if (!u) return { ok: false, error: 'admin only' }
  const supabase = db()
  if (confirmed) await supabase.from('ops_health_state').upsert({ condition: 'checklist:manual', state: 'green', since: new Date().toISOString(), detail: `confirmed by ${u.name ?? u.id}`, updated_at: new Date().toISOString() }, { onConflict: 'condition' })
  else await supabase.from('ops_health_state').delete().eq('condition', 'checklist:manual')
  revalidatePath('/admin/ops')
  return { ok: true }
}

export async function cancelCommandAction(id: string): Promise<{ ok: boolean }> {
  const u = await admin()
  if (!u) return { ok: false }
  await db().from('extension_commands').update({ status: 'failed', finished_at: new Date().toISOString(), result: { cancelled: true } }).eq('id', id).eq('status', 'pending')
  revalidatePath('/admin/ops')
  return { ok: true }
}
