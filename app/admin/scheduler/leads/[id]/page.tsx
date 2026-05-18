import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import LeadDetailClient from './LeadDetailClient'

export const dynamic = 'force-dynamic'

interface Props {
  params: Promise<{ id: string }>
}

export default async function LeadDetailPage({ params }: Props) {
  const { id } = await params
  const supabase = await createClient()

  const { data: lead } = await supabase
    .from('scheduler_leads')
    .select('*')
    .eq('id', id)
    .single()

  if (!lead) notFound()

  // Fetch approver name if present
  let approverName: string | null = null
  if (lead.approved_by) {
    const { data: approver } = await supabase
      .from('profiles')
      .select('full_name')
      .eq('id', lead.approved_by)
      .single()
    approverName = approver?.full_name ?? null
  }

  return <LeadDetailClient lead={lead} approverName={approverName} />
}
