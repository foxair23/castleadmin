'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

async function assertAdmin(): Promise<string> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: profile } = await supabase
    .from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') redirect('/login')
  return user.id
}

export async function createWidget(displayName: string, leadSource: string) {
  const userId = await assertAdmin()

  // Use service role to generate api_key via Postgres random bytes
  const db = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  const id = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30)
    + '_' + Date.now().toString(36)

  const { data, error } = await db.rpc('generate_widget_api_key').single()
  const apiKey = (data as string) ?? crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')

  if (error) {
    // Fallback: 64-char hex from two UUIDs
  }

  const { error: insertError } = await db
    .from('scheduler_widget_instances')
    .insert({ id, display_name: displayName, lead_source: leadSource, api_key: apiKey, created_by: userId })

  if (insertError) throw new Error(insertError.message)
  revalidatePath('/admin/scheduler/widgets')
}

export async function toggleWidget(id: string, isActive: boolean) {
  await assertAdmin()
  const supabase = await createClient()
  const { error } = await supabase
    .from('scheduler_widget_instances')
    .update({ is_active: isActive })
    .eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/admin/scheduler/widgets')
}
