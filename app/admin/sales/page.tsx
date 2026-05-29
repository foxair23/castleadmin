import { createClient as createAdminClient } from '@supabase/supabase-js'
import AdminSalesClient from './AdminSalesClient'

export const dynamic = 'force-dynamic'

// Admin layout already enforces admin role — no need to re-check here.

function db() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

export default async function AdminSalesPage() {
  const database = db()

  const [
    campaignsRes,
    statusesRes,
    dispositionsRes,
    unmatchedRes,
    repsRes,
    tagsRes,
    leadCountsRes,
  ] = await Promise.all([
    // All campaigns, newest first
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (database as any)
      .from('mc_campaigns')
      .select('mailchimp_campaign_id, subject, tag_name, send_time, total_recipients, total_opens, total_clicks, is_tracked, last_synced_at')
      .order('send_time', { ascending: false })
      .limit(50),

    // Pipeline statuses (all, including inactive)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (database as any)
      .from('sales_pipeline_statuses')
      .select('id, name, sort_order, is_active')
      .order('sort_order'),

    // Call dispositions (all, including inactive)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (database as any)
      .from('sales_call_dispositions')
      .select('id, name, sort_order, is_active')
      .order('sort_order'),

    // Unmatched engagements (customer_id IS NULL), limit 50
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (database as any)
      .from('mc_campaign_engagement')
      .select('id, mailchimp_campaign_id, email, open_count, click_count, first_opened_at')
      .is('customer_id', null)
      .order('open_count', { ascending: false })
      .limit(50),

    // Admin + sales users as potential assignees
    database
      .from('profiles')
      .select('id, full_name, role')
      .in('role', ['admin', 'sales'])
      .eq('is_active', true)
      .order('full_name'),

    // Distinct tags from sales_leads (for bulk assign filter)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (database as any)
      .from('sales_leads')
      .select('tag_name')
      .not('tag_name', 'is', null),

    // Lead counts per status (for deletion guard on pipeline editor)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (database as any)
      .from('sales_leads')
      .select('status'),
  ])

  // Compute distinct tags
  const allTagNames = [
    ...new Set(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((tagsRes.data ?? []) as any[]).map((r: any) => r.tag_name as string).filter(Boolean)
    ),
  ].sort()

  // Build status usage counts
  const statusUsageCounts: Record<string, number> = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const l of (leadCountsRes.data ?? []) as any[]) {
    statusUsageCounts[l.status] = (statusUsageCounts[l.status] ?? 0) + 1
  }

  // Join campaign subject to unmatched engagements
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const campaignMap = new Map(((campaignsRes.data ?? []) as any[]).map((c: any) => [c.mailchimp_campaign_id, c.subject]))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unmatched = ((unmatchedRes.data ?? []) as any[]).map((e: any) => ({
    ...e,
    campaign_subject: campaignMap.get(e.mailchimp_campaign_id) ?? null,
  }))

  return (
    <AdminSalesClient
      campaigns={(campaignsRes.data ?? []) as any[]}
      pipelineStatuses={(statusesRes.data ?? []) as any[]}
      callDispositions={(dispositionsRes.data ?? []) as any[]}
      unmatched={unmatched}
      reps={(repsRes.data ?? []) as any[]}
      tags={allTagNames}
      statusUsageCounts={statusUsageCounts}
    />
  )
}
