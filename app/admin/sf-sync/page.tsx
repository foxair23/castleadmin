import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getSyncStatus, getMirrorCounts } from '@/lib/sf-mirror/sync-engine'
import SfSyncClient from './SfSyncClient'

export default async function SfSyncPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: profile } = await db
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (profile?.role !== 'admin') redirect('/admin')

  const [runs, counts] = await Promise.all([
    getSyncStatus(),
    getMirrorCounts(),
  ])

  return <SfSyncClient runs={runs} counts={counts} />
}
