import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import {
  getUnpaidJobs,
  getUninvoicedJobs,
  getStaleEstimates,
  getFollowUpJobs,
  getOverdueCustomers,
  getAwaitingSfJob,
  getAwaitingPushLeads,
} from '@/lib/analytics/alerts'
import ActionItemsClient from './ActionItemsClient'

export default async function ActionItemsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (profile?.role !== 'admin') redirect('/admin')

  const [unpaidJobs, uninvoicedJobs, staleEstimates, followUpJobs, overdueCustomers, awaitingSfJob, awaitingPushLeads] =
    await Promise.all([
      getUnpaidJobs(),
      getUninvoicedJobs(),
      getStaleEstimates(),
      getFollowUpJobs(),
      getOverdueCustomers(),
      getAwaitingSfJob(),
      getAwaitingPushLeads(),
    ])

  return (
    <ActionItemsClient
      unpaidJobs={unpaidJobs}
      uninvoicedJobs={uninvoicedJobs}
      staleEstimates={staleEstimates}
      followUpJobs={followUpJobs}
      overdueCustomers={overdueCustomers}
      awaitingSfJob={awaitingSfJob}
      awaitingPushLeads={awaitingPushLeads}
    />
  )
}
