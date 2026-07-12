import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  getUnpaidJobs,
  getUninvoicedJobs,
  getStaleEstimates,
  getFollowUpJobs,
  getAwaitingSfJob,
  getOnlineSchedulingLeads,
  getAcceptedEstimatesAwaitingJob,
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

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const [unpaidJobs, uninvoicedJobs, staleEstimates, followUpJobs, awaitingSfJob, onlineScheduling, acceptedEstimates, notesResult] =
    await Promise.all([
      getUnpaidJobs(),
      getUninvoicedJobs(),
      getStaleEstimates(),
      getFollowUpJobs(),
      getAwaitingSfJob(),
      getOnlineSchedulingLeads(),
      getAcceptedEstimatesAwaitingJob(),
      db.from('action_item_notes').select('entity_type, entity_id, note'),
    ])

  const notes: Record<string, string> = {}
  for (const n of notesResult.data ?? []) {
    notes[`${n.entity_type}:${n.entity_id}`] = n.note
  }

  // Action-tracking rows (button presses + follow-up dates), keyed like notes.
  const { data: actionRows } = await db
    .from('action_item_actions')
    .select('entity_type, entity_id, action_label, actioned_at, follow_up_on, actioned_by')
  const actorIds = [...new Set((actionRows ?? []).map(a => a.actioned_by).filter(Boolean))] as string[]
  const actorNames = new Map<string, string>()
  if (actorIds.length > 0) {
    const { data: actors } = await db.from('profiles').select('id, full_name').in('id', actorIds)
    for (const a of actors ?? []) actorNames.set(a.id, a.full_name)
  }
  const actions: Record<string, import('@/lib/action-items/config').ActionRecord> = {}
  for (const a of actionRows ?? []) {
    actions[`${a.entity_type}:${a.entity_id}`] = {
      action_label: a.action_label,
      actioned_at: a.actioned_at,
      actioned_by_name: a.actioned_by ? (actorNames.get(a.actioned_by) ?? null) : null,
      follow_up_on: a.follow_up_on,
    }
  }

  return (
    <ActionItemsClient
      unpaidJobs={unpaidJobs}
      uninvoicedJobs={uninvoicedJobs}
      staleEstimates={staleEstimates}
      followUpJobs={followUpJobs}
      awaitingSfJob={awaitingSfJob}
      onlineScheduling={onlineScheduling}
      acceptedEstimates={acceptedEstimates}
      actions={actions}
      notes={notes}
    />
  )
}
