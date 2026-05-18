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

export async function approveLead(id: string) {
  const supabase = await createClient()
  const userId = await getAdminUserId()

  const { error } = await supabase
    .from('scheduler_leads')
    .update({
      status: 'approved',
      approved_by: userId,
      approved_at: new Date().toISOString(),
    })
    .eq('id', id)

  if (error) throw new Error(error.message)

  revalidatePath('/admin/scheduler/leads')
  revalidatePath(`/admin/scheduler/leads/${id}`)
}

export async function rejectLead(id: string, reason: string) {
  const supabase = await createClient()
  await getAdminUserId()

  const { error } = await supabase
    .from('scheduler_leads')
    .update({
      status: 'rejected',
      rejected_reason: reason || null,
    })
    .eq('id', id)

  if (error) throw new Error(error.message)

  revalidatePath('/admin/scheduler/leads')
  revalidatePath(`/admin/scheduler/leads/${id}`)
}

export async function updateLeadNotes(id: string, notes: string) {
  const supabase = await createClient()
  await getAdminUserId()

  const { error } = await supabase
    .from('scheduler_leads')
    .update({ notes_internal: notes })
    .eq('id', id)

  if (error) throw new Error(error.message)

  revalidatePath(`/admin/scheduler/leads/${id}`)
}
