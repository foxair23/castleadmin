import { createClient as createAdminClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import InvoiceRemindersClient from './InvoiceRemindersClient'
import { isDialpadConfigured } from '@/lib/dialpad/client'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Invoice Reminders' }

export default async function InvoiceRemindersPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') redirect('/')

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  const [{ data: settings }, { data: sourceRows }, { data: recent }, { data: inbound }] = await Promise.all([
    db.from('invoice_reminder_settings').select('*').eq('id', 1).maybeSingle(),
    db.from('sf_sources').select('short_name').eq('is_deleted', false).not('short_name', 'is', null).order('short_name'),
    db.from('invoice_reminders').select('id, sf_invoice_id, sf_job_id, stage_day, channel, recipient, status, error, amount_due, sent_at').order('sent_at', { ascending: false }).limit(50),
    db.from('dialpad_inbound_events').select('id, received_at, verified, from_number, message_text, action').order('received_at', { ascending: false }).limit(25),
  ])

  const sources = [...new Set((sourceRows ?? []).map(r => r.short_name as string).filter(Boolean))]

  return (
    <InvoiceRemindersClient
      settings={settings as never}
      sources={sources}
      recent={(recent ?? []) as never}
      inbound={(inbound ?? []) as never}
      dialpadConfigured={isDialpadConfigured()}
    />
  )
}
