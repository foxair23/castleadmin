'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { testConnection, sendSms, registerInboundWebhook, toE164 } from '@/lib/dialpad/client'
import { getPlannedSends, loadSettings, type CadenceStage, type PlannedSend } from '@/lib/invoice-reminders/engine'

async function assertAdmin(): Promise<string> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') redirect('/login')
  return user.id
}

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

export async function setEnabled(enabled: boolean) {
  const userId = await assertAdmin()
  // Fresh-start: stamp activated_at every time it's turned on, so enabling never
  // chases the existing backlog.
  const patch: Record<string, unknown> = { enabled, updated_at: new Date().toISOString(), updated_by: userId }
  if (enabled) patch.activated_at = new Date().toISOString()
  const { error } = await svc().from('invoice_reminder_settings').update(patch).eq('id', 1)
  if (error) throw new Error(error.message)
  revalidatePath('/admin/invoice-reminders')
}

export async function saveSettings(input: {
  send_hour_pt: number
  excluded_sources: string[]
  cadence: CadenceStage[]
  reply_to_email: string
}) {
  const userId = await assertAdmin()
  // Validate cadence shape, preserving each stage's copy.
  const cadence = (input.cadence ?? [])
    .filter(s => Number.isFinite(s.day) && Array.isArray(s.channels) && s.channels.length > 0)
    .map(s => ({
      day: Math.max(0, Math.round(s.day)),
      channels: s.channels.filter(c => c === 'email' || c === 'sms'),
      email_subject: String(s.email_subject ?? ''),
      email_body: String(s.email_body ?? ''),
      sms_body: String(s.sms_body ?? ''),
    }))
    .sort((a, b) => a.day - b.day)
  const { error } = await svc().from('invoice_reminder_settings').update({
    send_hour_pt: Math.min(23, Math.max(0, Math.round(input.send_hour_pt))),
    excluded_sources: input.excluded_sources ?? [],
    cadence,
    reply_to_email: input.reply_to_email.trim() || null,
    updated_at: new Date().toISOString(),
    updated_by: userId,
  }).eq('id', 1)
  if (error) throw new Error(error.message)
  revalidatePath('/admin/invoice-reminders')
}

// Dry-run: everything that matches the (possibly unsaved) cadence right now.
// The fresh-start window is opened here on purpose — the preview shows the full
// picture of who your schedule matches so you can tune the numbers; the note in
// the UI explains that an enabled fresh-start run only sends new stage-crossings.
export async function previewPlan(input: { cadence: CadenceStage[]; excluded_sources: string[] }): Promise<{ count: number; sample: PlannedSend[] }> {
  await assertAdmin()
  const settings = await loadSettings()
  settings.cadence = input.cadence
  settings.excluded_sources = input.excluded_sources
  settings.activated_at = '2000-01-01T00:00:00Z' // open the window for preview
  const plan = await getPlannedSends(settings)
  return { count: plan.length, sample: plan.slice(0, 50) }
}

export async function testDialpad(toNumber: string): Promise<{ conn: Awaited<ReturnType<typeof testConnection>>; send: Awaited<ReturnType<typeof sendSms>> | null }> {
  await assertAdmin()
  const conn = await testConnection()
  const e164 = toE164(toNumber)
  let send = null
  if (e164) send = await sendSms(e164, 'Castle Garage Inc: Dialpad test from Invoice Reminders. Reply STOP to opt out.')
  return { conn, send }
}

export async function registerWebhook(): Promise<Awaited<ReturnType<typeof registerInboundWebhook>>> {
  await assertAdmin()
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://castleadmin.vercel.app'
  return registerInboundWebhook(`${appUrl}/api/dialpad/sms-webhook`)
}

export async function setSkip(sfInvoiceId: string, skip: boolean) {
  const userId = await assertAdmin()
  const db = svc()
  if (skip) {
    const { error } = await db.from('invoice_reminder_skips').upsert({ sf_invoice_id: sfInvoiceId, created_by: userId }, { onConflict: 'sf_invoice_id' })
    if (error) throw new Error(error.message)
  } else {
    const { error } = await db.from('invoice_reminder_skips').delete().eq('sf_invoice_id', sfInvoiceId)
    if (error) throw new Error(error.message)
  }
  revalidatePath('/admin/invoice-reminders')
  revalidatePath('/admin/action-items')
}
