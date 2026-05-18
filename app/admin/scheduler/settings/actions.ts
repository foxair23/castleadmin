'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

async function getAdminUserId(): Promise<string> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, is_active')
    .eq('id', user.id)
    .single()
  if (!profile?.is_active || profile.role !== 'admin') redirect('/login')
  return user.id
}

export async function saveSetting(key: string, value: unknown) {
  const supabase = await createClient()
  const userId = await getAdminUserId()

  // Read old value for audit log
  const { data: existing } = await supabase
    .from('scheduler_settings')
    .select('value')
    .eq('key', key)
    .single()

  const { error } = await supabase
    .from('scheduler_settings')
    .upsert({ key, value, updated_at: new Date().toISOString(), updated_by: userId })

  if (error) throw new Error(error.message)

  // Audit log
  await supabase.from('scheduler_settings_log').insert({
    key,
    old_value: existing?.value ?? null,
    new_value: value,
    changed_by: userId,
  })

  revalidatePath('/admin/scheduler/settings')
}
