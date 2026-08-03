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

async function assertAdmin(): Promise<string> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') redirect('/login')
  return user.id
}

// Both the admin (/admin/leadgen) and sales (/sales/leadgen) views render the
// same client, so mutations must refresh both.
function revalidateLeadGen() {
  revalidatePath('/admin/leadgen')
  revalidatePath('/sales/leadgen')
}

function svc() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

/** Master on/off for auto-sending lead outreach. Admin + sales. */
export async function setLeadGenEnabled(enabled: boolean) {
  const userId = await assertStaff()
  const { error } = await svc().from('leadgen_settings')
    .update({ enabled, updated_at: new Date().toISOString(), updated_by: userId }).eq('id', 1)
  if (error) throw new Error(error.message)
  revalidateLeadGen()
}

/** Reply-To inbox for outreach emails (so customer replies reach a human).
 *  Admin-only — sales can see it but not change it. */
export async function setLeadGenReplyTo(email: string) {
  const userId = await assertAdmin()
  const value = email.trim() || null
  const { error } = await svc().from('leadgen_settings')
    .update({ reply_to_email: value, updated_at: new Date().toISOString(), updated_by: userId }).eq('id', 1)
  if (error) throw new Error(error.message)
  revalidateLeadGen()
}

/** Manually set a lead's status (e.g. mark not-interested / reopen). Admin + sales. */
export async function updateLeadStatus(leadId: string, status: 'contacted' | 'not_interested' | 'callback' | 'booked') {
  await assertStaff()
  const { error } = await svc().from('leads').update({ status, updated_at: new Date().toISOString() }).eq('id', leadId)
  if (error) throw new Error(error.message)
  revalidateLeadGen()
}

/** Send (or re-send) the first-touch email + SMS for a lead now. Admin + sales. */
export async function sendOutreachNow(leadId: string): Promise<{ sent: string[] }> {
  await assertStaff()
  const lead = await getLead(leadId)
  if (!lead) throw new Error('Lead not found')
  const sent = await sendLeadOutreach(lead)
  revalidateLeadGen()
  return { sent }
}
