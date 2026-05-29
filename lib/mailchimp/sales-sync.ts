// Server-side only — never import this in client components
// Orchestrates the "Sync from Mailchimp" button logic for the Sales Dashboard.

import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  listCampaigns,
  getCampaignOpeners,
  getCampaignClickers,
  getCampaignReport,
  type McRawCampaign,
} from './report'

function db() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

export interface SalesSyncResult {
  campaignsSynced: number
  newOpeners: number
  newClickers: number
}

// Extract the Castle-push tag from a campaign's segment_text.
// Mailchimp returns segment_text like "Tag: spring-tune-up" for tag-targeted
// campaigns. We strip the prefix and match against known push-log tags.
function parseTagFromSegmentText(segmentText: string | null | undefined): string | null {
  if (!segmentText) return null
  const match = segmentText.match(/^Tag:\s*(.+)$/i)
  return match ? match[1].trim() : null
}

// Build a map of email → sf_customers.id by joining sf_customer_contacts.
// We chunk the email list to stay under Supabase's IN-clause limit.
async function resolveEmailsToCustomerIds(
  supabase: ReturnType<typeof db>,
  emails: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (emails.length === 0) return map

  const CHUNK = 500
  for (let i = 0; i < emails.length; i += CHUNK) {
    const chunk = emails.slice(i, i + CHUNK).map(e => e.toLowerCase())
    const { data } = await supabase
      .from('sf_customer_contacts')
      .select('customer_id, email')
      .in('email', chunk)
    for (const row of data ?? []) {
      if (row.email && row.customer_id) {
        map.set(row.email.toLowerCase(), row.customer_id)
      }
    }
  }
  return map
}

async function syncOneCampaign(
  supabase: ReturnType<typeof db>,
  campaign: McRawCampaign,
  knownTags: Set<string>
): Promise<{ newOpeners: number; newClickers: number }> {
  const campaignId = campaign.id
  const now = new Date().toISOString()

  // Determine tag_name: prefer parsed segment text if it matches a known push tag
  const parsedTag = parseTagFromSegmentText(campaign.recipients?.segment_text)
  const tagName = parsedTag && knownTags.has(parsedTag) ? parsedTag : parsedTag

  // Fetch engagement and report summary in parallel
  const [openers, clickers, report] = await Promise.all([
    getCampaignOpeners(campaignId),
    getCampaignClickers(campaignId),
    getCampaignReport(campaignId),
  ])

  // Upsert mc_campaigns row
  await supabase
    .from('mc_campaigns')
    .upsert(
      {
        mailchimp_campaign_id: campaignId,
        mailchimp_audience_id: campaign.recipients?.list_id ?? null,
        subject: campaign.settings?.subject_line ?? null,
        send_time: campaign.send_time || null,
        tag_name: tagName,
        total_recipients: campaign.emails_sent ?? report?.emails_sent ?? null,
        total_opens: report?.opens?.unique_opens ?? campaign.report_summary?.unique_opens ?? null,
        total_clicks: report?.clicks?.clicks_total ?? campaign.report_summary?.clicks ?? null,
        is_tracked: true,
        last_synced_at: now,
      },
      { onConflict: 'mailchimp_campaign_id' }
    )

  if (openers.length === 0 && clickers.length === 0) {
    return { newOpeners: 0, newClickers: 0 }
  }

  // Resolve all emails to customer IDs in one pass
  const allEmails = Array.from(
    new Set([...openers.map(o => o.email_address), ...clickers.map(c => c.email_address)])
  )
  const emailToCustomerId = await resolveEmailsToCustomerIds(supabase, allEmails)

  // Build click count lookup
  const clickMap = new Map(clickers.map(c => [c.email_address.toLowerCase(), c.clicks]))

  // Upsert mc_campaign_engagement rows
  const engagementRows = openers.map(o => ({
    mailchimp_campaign_id: campaignId,
    email: o.email_address.toLowerCase(),
    customer_id: emailToCustomerId.get(o.email_address.toLowerCase()) ?? null,
    first_opened_at: o.first_open || null,
    last_opened_at: o.last_open || o.first_open || null,
    open_count: o.opens_count,
    click_count: clickMap.get(o.email_address.toLowerCase()) ?? 0,
    last_synced_at: now,
  }))

  if (engagementRows.length > 0) {
    // Upsert in chunks of 500
    for (let i = 0; i < engagementRows.length; i += 500) {
      await supabase
        .from('mc_campaign_engagement')
        .upsert(engagementRows.slice(i, i + 500), {
          onConflict: 'mailchimp_campaign_id,email',
          ignoreDuplicates: false,
        })
    }
  }

  // Create/update sales_leads for matched customers
  // Fetch existing leads for this campaign to know which are new
  const matchedCustomerIds = Array.from(
    new Set(engagementRows.map(r => r.customer_id).filter(Boolean) as string[])
  )

  if (matchedCustomerIds.length === 0) {
    return { newOpeners: 0, newClickers: 0 }
  }

  const { data: existingLeads } = await supabase
    .from('sales_leads')
    .select('id, customer_id, open_count, click_count')
    .eq('mailchimp_campaign_id', campaignId)
    .in('customer_id', matchedCustomerIds)

  const existingByCustomer = new Map(existingLeads?.map(l => [l.customer_id, l]) ?? [])

  // Look up standing tag assignments for auto-assignment
  let autoAssignUserId: string | null = null
  if (tagName) {
    const { data: tagRule } = await supabase
      .from('mc_tag_assignments')
      .select('assigned_to_user_id')
      .eq('tag_name', tagName)
      .single()
    autoAssignUserId = tagRule?.assigned_to_user_id ?? null
  }

  let newOpeners = 0
  let newClickers = 0

  for (const row of engagementRows) {
    if (!row.customer_id) continue
    const existing = existingByCustomer.get(row.customer_id)

    if (!existing) {
      // New lead
      newOpeners++
      if (row.click_count > 0) newClickers++

      await supabase.from('sales_leads').insert({
        customer_id: row.customer_id,
        mailchimp_campaign_id: campaignId,
        tag_name: tagName,
        status: 'New',
        assigned_to_user_id: autoAssignUserId,
        assigned_at: autoAssignUserId ? now : null,
        first_opened_at: row.first_opened_at,
        last_opened_at: row.last_opened_at,
        open_count: row.open_count,
        first_clicked_at: row.click_count > 0 ? row.last_synced_at : null,
        click_count: row.click_count,
        last_activity_at: row.last_opened_at ?? now,
      })
    } else {
      // Update engagement counts on existing lead
      const wasClicker = (existing.click_count ?? 0) === 0 && row.click_count > 0
      if (wasClicker) newClickers++

      await supabase
        .from('sales_leads')
        .update({
          open_count: row.open_count,
          last_opened_at: row.last_opened_at,
          click_count: row.click_count,
          ...(wasClicker ? { first_clicked_at: now } : {}),
          last_activity_at: row.last_opened_at ?? now,
        })
        .eq('id', existing.id)
    }
  }

  return { newOpeners, newClickers }
}

export async function runMailchimpSalesSync(triggeredByUserId: string): Promise<SalesSyncResult> {
  const supabase = db()
  const now = new Date().toISOString()

  // Collect known Castle-push tags from the push log for tag detection
  const { data: pushLogTags } = await supabase
    .from('mailchimp_push_log')
    .select('tag')
  const knownTags = new Set((pushLogTags ?? []).map(r => r.tag as string))

  const campaigns = await listCampaigns()

  // Only process campaigns sent to our configured audience
  const audienceId = process.env.MAILCHIMP_AUDIENCE_ID ?? ''
  const relevant = campaigns.filter(
    c => !audienceId || c.recipients?.list_id === audienceId
  )

  let totalNewOpeners = 0
  let totalNewClickers = 0
  let campaignsSynced = 0
  let syncError: string | null = null

  try {
    // Process campaigns sequentially to avoid overwhelming Mailchimp rate limits
    for (const campaign of relevant) {
      const { newOpeners, newClickers } = await syncOneCampaign(supabase, campaign, knownTags)
      totalNewOpeners += newOpeners
      totalNewClickers += newClickers
      campaignsSynced++
    }
  } catch (err: unknown) {
    syncError = err instanceof Error ? err.message : 'Unknown error'
  }

  // Record the sync run
  await supabase.from('mc_sync_runs').insert({
    triggered_by_user: triggeredByUserId,
    triggered_at: now,
    campaigns_synced: campaignsSynced,
    new_openers: totalNewOpeners,
    new_clickers: totalNewClickers,
    success: syncError === null,
    error_message: syncError,
  })

  if (syncError) throw new Error(syncError)

  return {
    campaignsSynced,
    newOpeners: totalNewOpeners,
    newClickers: totalNewClickers,
  }
}
