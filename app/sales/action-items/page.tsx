import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  getUnpaidJobs,
  getUninvoicedJobs,
  getStaleEstimates,
  getFollowUpJobs,
  getOverdueCustomers,
  getAwaitingSfJob,
  getOnlineSchedulingLeads,
  getWonEstimatesWithoutJob,
} from '@/lib/analytics/alerts'
import ActionItemsClient from '@/app/admin/action-items/ActionItemsClient'

export default async function SalesActionItemsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!['admin', 'sales'].includes(profile?.role ?? '')) redirect('/sales')

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const [unpaidJobs, uninvoicedJobs, staleEstimates, followUpJobs, overdueCustomers, awaitingSfJob, onlineScheduling, wonEstimates, notesResult] =
    await Promise.all([
      getUnpaidJobs(),
      getUninvoicedJobs(),
      getStaleEstimates(),
      getFollowUpJobs(),
      getOverdueCustomers(),
      getAwaitingSfJob(),
      getOnlineSchedulingLeads(),
      getWonEstimatesWithoutJob(),
      db.from('action_item_notes').select('entity_type, entity_id, note'),
    ])

  const notes: Record<string, string> = {}
  for (const n of notesResult.data ?? []) {
    notes[`${n.entity_type}:${n.entity_id}`] = n.note
  }

  return (
    <ActionItemsClient
      unpaidJobs={unpaidJobs}
      uninvoicedJobs={uninvoicedJobs}
      staleEstimates={staleEstimates}
      followUpJobs={followUpJobs}
      overdueCustomers={overdueCustomers}
      awaitingSfJob={awaitingSfJob}
      onlineScheduling={onlineScheduling}
      wonEstimates={wonEstimates}
      notes={notes}
    />
  )
}
