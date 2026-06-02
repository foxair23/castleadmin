import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
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

  const adminDb = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  const [approverRes, feesRes] = await Promise.all([
    lead.approved_by
      ? supabase.from('profiles').select('full_name').eq('id', lead.approved_by).single()
      : Promise.resolve({ data: null }),
    adminDb
      .from('scheduler_settings')
      .select('key, value')
      .in('key', ['service_call_fee', 'gate_service_call_fee']),
  ])

  const approverName: string | null = approverRes.data?.full_name ?? null
  const feeMap: Record<string, number> = {}
  for (const row of feesRes.data ?? []) feeMap[row.key] = Number(row.value)
  const garageServiceCallFee = feeMap['service_call_fee'] ?? 99
  const gateServiceCallFee = feeMap['gate_service_call_fee'] ?? garageServiceCallFee

  return (
    <LeadDetailClient
      lead={lead}
      approverName={approverName}
      garageServiceCallFee={garageServiceCallFee}
      gateServiceCallFee={gateServiceCallFee}
    />
  )
}
