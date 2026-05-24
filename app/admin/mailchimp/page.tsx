import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import MailchimpClient from './MailchimpClient'

interface PushLogRow {
  id: string
  pushed_at: string
  tag: string
  contact_count: number
  added_count: number
  updated_count: number
  skipped_count: number
  failed_count: number
}

export default async function MailchimpPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') redirect('/admin')

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: pushLog } = await db
    .from('mailchimp_push_log')
    .select('id, pushed_at, tag, contact_count, added_count, updated_count, skipped_count, failed_count')
    .order('pushed_at', { ascending: false })
    .limit(20)

  return (
    <MailchimpClient
      pushLog={(pushLog ?? []) as PushLogRow[]}
      serverPrefix={process.env.MAILCHIMP_SERVER_PREFIX ?? ''}
    />
  )
}
