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

  const [approverRes, feesRes, attachmentRes] = await Promise.all([
    lead.approved_by
      ? supabase.from('profiles').select('full_name').eq('id', lead.approved_by).single()
      : Promise.resolve({ data: null }),
    adminDb
      .from('scheduler_settings')
      .select('key, value')
      .in('key', ['service_call_fee', 'gate_service_call_fee']),
    adminDb
      .from('scheduler_lead_attachments')
      .select('filename, storage_path, mime_type')
      .eq('lead_id', id)
      .order('uploaded_at', { ascending: true }),
  ])

  // Fresh short-lived signed URLs per view — the bucket is private.
  const attachments: { filename: string; mime_type: string; url: string }[] = []
  for (const a of (attachmentRes.data ?? []) as { filename: string; storage_path: string; mime_type: string }[]) {
    const { data: signed } = await adminDb.storage
      .from('scheduler-uploads')
      .createSignedUrl(a.storage_path, 60 * 60) // 1 hour
    if (signed?.signedUrl) {
      attachments.push({ filename: a.filename, mime_type: a.mime_type, url: signed.signedUrl })
    }
  }

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
      attachments={attachments}
    />
  )
}
