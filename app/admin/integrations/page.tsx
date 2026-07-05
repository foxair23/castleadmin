import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getSyncStatus, getMirrorCounts } from '@/lib/sf-mirror/sync-engine'
import IntegrationsClient from './IntegrationsClient'

export const dynamic = 'force-dynamic'

function db() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

export default async function IntegrationsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const database = db()
  const { data: profile } = await database.from('profiles').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') redirect('/admin')

  const [runs, counts, pushLogRes] = await Promise.all([
    getSyncStatus(),
    getMirrorCounts(),
    database
      .from('mailchimp_push_log')
      .select('id, pushed_at, tag, contact_count, added_count, updated_count, skipped_count, failed_count')
      .order('pushed_at', { ascending: false })
      .limit(20),
  ])

  return (
    <IntegrationsClient
      runs={runs}
      counts={counts}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pushLog={(pushLogRes.data ?? []) as any[]}
      serverPrefix={process.env.MAILCHIMP_SERVER_PREFIX ?? ''}
    />
  )
}
