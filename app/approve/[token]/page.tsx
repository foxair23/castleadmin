import { notFound } from 'next/navigation'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  buildTokens,
  renderItemsTableHtml,
  renderLegalHtml,
  type ApprovalLineItem,
} from '@/lib/approvals/acceptance'
import { LEGAL_VERSION } from '@/lib/approvals/legal'
import ApproveClient from './ApproveClient'

export const dynamic = 'force-dynamic'

function adminDb() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

export default async function ApprovePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  const db = adminDb()
  const { data: approval } = await db
    .from('job_approvals')
    .select('token, status, customer_name, line_items_snapshot, amount_total, legal_version, approved_name, approved_at')
    .eq('token', token)
    .maybeSingle()

  if (!approval) notFound()

  const items = (approval.line_items_snapshot ?? []) as ApprovalLineItem[]
  const total = Number(approval.amount_total ?? 0)
  const tokens = buildTokens({
    customerName: approval.customer_name as string | null,
    amountTotal: total,
  })
  const itemsHtml = renderItemsTableHtml(items, total)
  const legalHtml = renderLegalHtml(tokens)

  const approvedAtHuman = approval.approved_at
    ? new Date(approval.approved_at as string).toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles', dateStyle: 'long', timeStyle: 'short',
      })
    : null

  return (
    <ApproveClient
      token={token}
      status={approval.status as 'pending' | 'approved' | 'declined' | 'expired'}
      customerName={(approval.customer_name as string | null) ?? null}
      itemsHtml={itemsHtml}
      legalHtml={legalHtml}
      legalVersion={(approval.legal_version as string) ?? LEGAL_VERSION}
      approvedName={(approval.approved_name as string | null) ?? null}
      approvedAt={approvedAtHuman}
    />
  )
}
