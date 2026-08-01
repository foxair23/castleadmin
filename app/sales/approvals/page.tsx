import { redirect } from 'next/navigation'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import ApprovalsClient, { type ApprovalRow } from './ApprovalsClient'

export const dynamic = 'force-dynamic'

export default async function ApprovalsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, is_active')
    .eq('id', user.id)
    .single()
  if (!profile?.is_active || !['admin', 'sales'].includes(profile.role ?? '')) redirect('/login')

  const db = await createServiceClient()
  const { data: rows } = await db
    .from('job_approvals')
    .select('id, source_id, customer_name, amount_total, status, approved_name, approved_at, created_at, sent_channels, ip')
    .order('created_at', { ascending: false })
    .limit(200)

  return <ApprovalsClient initialRows={(rows ?? []) as ApprovalRow[]} />
}
