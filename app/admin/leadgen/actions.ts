'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { getLead, sendLeadOutreach } from '@/lib/leadgen/engine'

async function assertStaff(): Promise<string> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || !['admin', 'sales'].includes(profile.role ?? '')) redirect('/login')
  return user.id
}

function svc() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

/** Master on/off for auto-sending lead outreach. */
export async function setLeadGenEnabled(enabled: boolean) {
  const userId = await assertStaff()
  const { error } = await svc().from('leadgen_settings')
    .update({ enabled, updated_at: new Date().toISOString(), updated_by: userId }).eq('id', 1)
  if (error) throw new Error(error.message)
  revalidatePath('/admin/leadgen')
}

/** Manually set a lead's status (e.g. mark not-interested / reopen). */
export async function updateLeadStatus(leadId: string, status: 'contacted' | 'not_interested' | 'callback' | 'booked') {
  await assertStaff()
  const { error } = await svc().from('leads').update({ status, updated_at: new Date().toISOString() }).eq('id', leadId)
  if (error) throw new Error(error.message)
  revalidatePath('/admin/leadgen')
}

/** Send (or re-send) the first-touch email + SMS for a lead now. */
export async function sendOutreachNow(leadId: string): Promise<{ sent: string[] }> {
  await assertStaff()
  const lead = await getLead(leadId)
  if (!lead) throw new Error('Lead not found')
  const sent = await sendLeadOutreach(lead)
  revalidatePath('/admin/leadgen')
  return { sent }
}
