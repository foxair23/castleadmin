'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getResendData, manualResend, type ResendData, type ResendResult } from '@/lib/invoice-reminders/engine'

// Manual resends are available to both admin and sales (they both work the
// Action Items → Unpaid Jobs tab).
async function assertAdminOrSales(): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || !['admin', 'sales'].includes(profile.role ?? '')) redirect('/login')
}

/** Modal payload for a job's unpaid invoice: per-stage rendered previews. */
export async function loadResendData(sfJobId: string): Promise<ResendData> {
  await assertAdminOrSales()
  return getResendData(sfJobId)
}

/** Re-fire the chosen stage of the series to one invoice, now. */
export async function resendReminder(sfInvoiceId: string, stageIndex: number): Promise<ResendResult> {
  await assertAdminOrSales()
  const res = await manualResend(sfInvoiceId, stageIndex)
  revalidatePath('/admin/action-items')
  revalidatePath('/sales/action-items')
  return res
}
