'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

async function getAuthorizedUser(): Promise<{ userId: string; isAdmin: boolean }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, is_active')
    .eq('id', user.id)
    .single()

  if (!profile?.is_active || !['admin', 'sales'].includes(profile.role ?? '')) {
    redirect('/login')
  }

  return { userId: user.id, isAdmin: profile.role === 'admin' }
}

function adminDb() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

async function assertLeadAccess(leadId: string, userId: string, isAdmin: boolean) {
  if (isAdmin) return
  const db = adminDb()
  const { data } = await db
    .from('sales_leads')
    .select('assigned_to_user_id')
    .eq('id', leadId)
    .single()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((data as any)?.assigned_to_user_id !== userId) redirect('/sales')
}

// Status auto-advance logic based on call disposition
function suggestStatusAdvance(currentStatus: string, disposition: string): string | null {
  if (disposition === 'Closed Won')  return 'Closed Won'
  if (disposition === 'Closed Lost') return 'Closed Lost'
  if (currentStatus === 'New') return 'Contacted'
  if ((currentStatus === 'New' || currentStatus === 'Contacted') && disposition === 'Connected') return 'Engaged'
  if (disposition === 'Quote Sent' && !['Quoted', 'Closed Won', 'Closed Lost'].includes(currentStatus)) return 'Quoted'
  return null
}

export async function logCall(
  leadId: string,
  disposition: string,
  durationMinutes: number | null,
  notes: string,
  calledAt: string,
) {
  const { userId, isAdmin } = await getAuthorizedUser()
  await assertLeadAccess(leadId, userId, isAdmin)

  const db = adminDb()
  const now = new Date().toISOString()

  await db.from('sales_calls').insert({
    lead_id: leadId,
    user_id: userId,
    called_at: calledAt || now,
    disposition,
    duration_minutes: durationMinutes || null,
    notes: notes.trim() || null,
  })

  // Fetch current status to compute advance
  const { data: lead } = await db
    .from('sales_leads')
    .select('status')
    .eq('id', leadId)
    .single()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const currentStatus = (lead as any)?.status ?? 'New'
  const nextStatus = suggestStatusAdvance(currentStatus, disposition)

  const updates: Record<string, unknown> = { last_activity_at: now }
  if (nextStatus && nextStatus !== currentStatus) {
    updates.status = nextStatus
    if (nextStatus === 'Closed Won' || nextStatus === 'Closed Lost') {
      updates.closed_at = now
      updates.closed_outcome = nextStatus === 'Closed Won' ? 'won' : 'lost'
    }

    await db.from('sales_status_history').insert({
      lead_id: leadId,
      user_id: userId,
      from_status: currentStatus,
      to_status: nextStatus,
      changed_at: now,
    })
  }

  await db.from('sales_leads').update(updates).eq('id', leadId)

  revalidatePath(`/sales/${leadId}`)
  revalidatePath('/sales')
}

export async function addNote(leadId: string, body: string) {
  const { userId, isAdmin } = await getAuthorizedUser()
  await assertLeadAccess(leadId, userId, isAdmin)

  const db = adminDb()
  const now = new Date().toISOString()

  await db.from('sales_notes').insert({
    lead_id: leadId,
    user_id: userId,
    body: body.trim(),
    created_at: now,
  })

  await db.from('sales_leads').update({ last_activity_at: now }).eq('id', leadId)

  revalidatePath(`/sales/${leadId}`)
}

export async function updateLeadStatus(leadId: string, newStatus: string) {
  const { userId, isAdmin } = await getAuthorizedUser()
  await assertLeadAccess(leadId, userId, isAdmin)

  const db = adminDb()
  const now = new Date().toISOString()

  const { data: lead } = await db
    .from('sales_leads')
    .select('status')
    .eq('id', leadId)
    .single()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fromStatus = (lead as any)?.status
  if (fromStatus === newStatus) return

  const updates: Record<string, unknown> = { status: newStatus, last_activity_at: now }
  if (newStatus === 'Closed Won' || newStatus === 'Closed Lost') {
    updates.closed_at = now
    updates.closed_outcome = newStatus === 'Closed Won' ? 'won' : 'lost'
  }

  await db.from('sales_leads').update(updates).eq('id', leadId)

  await db.from('sales_status_history').insert({
    lead_id: leadId,
    user_id: userId,
    from_status: fromStatus,
    to_status: newStatus,
    changed_at: now,
  })

  revalidatePath(`/sales/${leadId}`)
  revalidatePath('/sales')
}

export async function markSfJobCreated(leadId: string) {
  const { userId, isAdmin } = await getAuthorizedUser()
  await assertLeadAccess(leadId, userId, isAdmin)

  const db = adminDb()
  await db
    .from('sales_leads')
    .update({ sf_job_created: true, sf_job_marked_created_at: new Date().toISOString() })
    .eq('id', leadId)

  revalidatePath(`/sales/${leadId}`)
  revalidatePath('/sales')
}
