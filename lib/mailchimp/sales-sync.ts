// Server-side only — never import this in client components
// Orchestrates the "Sync from Mailchimp" button logic for the Sales Dashboard.

import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  listCampaigns,
  listAudienceTags,
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
  totalOpeners: number   // raw opener count from Mailchimp before any resolution
  newOpeners: number     // new sales_leads created (matched to SF customer, first time)
  newClickers: number
  unmatchedEmails: number  // openers whose email didn't resolve to an SF customer
}

// Build a map of email → sf_customers.id by joining sf_customer_contacts.
// We chunk the email list and use ilike for case-insensitive matching because
// SF may store emails with mixed case (e.g. "John@Gmail.com") while Mailchimp
// normalizes to lowercase — a case-sensitive IN would miss them entirely.
async function resolveEmailsToCustomerIds(
  supabase: ReturnType<typeof db>,
  emails: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (emails.length === 0) return map

  const CHUNK = 200  // smaller chunks because OR-ilike expands the query
  for (let i = 0; i < emails.length; i += CHUNK) {
    const chunk = emails.slice(i, i + CHUNK)
    // Build OR filter with ilike so matching is case-insensitive
    const orFilter = chunk
      .map(e => `email.ilike.${e.replace(/[%_]/g, '\\$&')}`)
      .join(',')
    const { data, error } = await supabase
      .from('sf_customer_contacts')
      .select('customer_id, email')
      .or(orFilter)
    if (error) console.error('[sales-sync] sf_customer_contacts query error:', error)
    console.log(`[sales-sync] email chunk ${i}–${i + chunk.length}: queried ${chunk.length} emails, got ${data?.length ?? 0} matches`)
    for (const row of data ?? []) {
      if (row.email && row.customer_id) {
        map.set(row.email.toLowerCase(), row.customer_id)
      }
    }
  }
  console.log(`[sales-sync] total emails resolved: ${map.size} of ${emails.length}`)
  return map
}

// Resolve a campaign's tag name from its segment_opts.
// Mailchimp represents tags as static segments. When a campaign targets a tag,
// segment_opts.conditions contains a StaticSegment condition whose value is the
// segment ID. We map that ID back to the tag name via segmentIdToTag.
function resolveTagName(
  campaign: McRawCampaign,
  segmentIdToTag: Map<number, string>
): string | null {
  const opts = campaign.recipients?.segment_opts
  console.log(`[sales-sync] campaign ${campaign.id} segment_opts:`, JSON.stringify(opts))

  if (!opts) return null

  // saved_segment_id is set when the campaign targeted a saved/static segment
  if (opts.saved_segment_id && opts.saved_segment_id > 0) {
    const tag = segmentIdToTag.get(opts.saved_segment_id) ?? null
    console.log(`[sales-sync] campaign ${campaign.id} saved_segment_id=${opts.saved_segment_id} → tag=${tag}`)
    return tag
  }

  // Fall back to conditions array
  const conditions = opts.conditions ?? []
  for (const c of conditions) {
    if (c.condition_type === 'StaticSegment' && typeof c.value === 'number') {
      const tag = segmentIdToTag.get(c.value) ?? null
      console.log(`[sales-sync] campaign ${campaign.id} StaticSegment value=${c.value} → tag=${tag}`)
      return tag
    }
  }

  console.log(`[sales-sync] campaign ${campaign.id} no tag resolved. segmentIdToTag keys: ${JSON.stringify([...segmentIdToTag.keys()])}`)
  return null
}

async function syncOneCampaign(
  supabase: ReturnType<typeof db>,
  campaign: McRawCampaign,
  segmentIdToTag: Map<number, string>
): Promise<{ totalOpeners: number; newOpeners: number; newClickers: number; unmatchedEmails: number }> {
  const campaignId = campaign.id
  const now = new Date().toISOString()

  const tagName = resolveTagName(campaign, segmentIdToTag)

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
        // Use actual unique opener count from email-activity as the most accurate source.
        // Fall back to report unique_opens when openers haven't been fetched yet.
        total_opens: openers.length > 0
          ? openers.length
          : (report?.opens?.unique_opens ?? campaign.report_summary?.unique_opens ?? null),
        // unique_clicks = distinct people who clicked; clicks_total counts repeated clicks by same person.
        total_clicks: report?.clicks?.unique_clicks ?? campaign.report_summary?.unique_clicks ?? null,
        is_tracked: true,
        last_synced_at: now,
      },
      { onConflict: 'mailchimp_campaign_id' }
    )

  console.log(`[sales-sync] campaign ${campaignId}: ${openers.length} openers, ${clickers.length} clickers from Mailchimp`)

  if (openers.length === 0 && clickers.length === 0) {
    return { totalOpeners: 0, newOpeners: 0, newClickers: 0, unmatchedEmails: 0 }
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

  const unmatchedEmails = engagementRows.filter(r => !r.customer_id).length

  console.log(`[sales-sync] campaign ${campaignId}: ${openers.length - unmatchedEmails} resolved to SF customers, ${unmatchedEmails} unmatched`)

  if (matchedCustomerIds.length === 0) {
    return { totalOpeners: openers.length, newOpeners: 0, newClickers: 0, unmatchedEmails }
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

  return { totalOpeners: openers.length, newOpeners, newClickers, unmatchedEmails }
}

export async function runMailchimpSalesSync(triggeredByUserId: string): Promise<SalesSyncResult> {
  const supabase = db()
  const now = new Date().toISOString()

  // Fetch all audience tags (static segments) to resolve campaign segment IDs → tag names.
  // Mailchimp represents tags as static segments; campaigns store the segment ID in
  // segment_opts, not the tag name, so we need this lookup table.
  const audienceTags = await listAudienceTags()
  const segmentIdToTag = new Map(audienceTags.map(t => [t.id, t.name]))

  const campaigns = await listCampaigns()

  // Only process campaigns sent to our configured audience
  const audienceId = process.env.MAILCHIMP_AUDIENCE_ID ?? ''
  const relevant = campaigns.filter(
    c => !audienceId || c.recipients?.list_id === audienceId
  )

  let grandTotalOpeners = 0
  let totalNewOpeners = 0
  let totalNewClickers = 0
  let totalUnmatched = 0
  let campaignsSynced = 0
  let syncError: string | null = null

  try {
    // Process campaigns sequentially to avoid overwhelming Mailchimp rate limits
    for (const campaign of relevant) {
      const { totalOpeners, newOpeners, newClickers, unmatchedEmails } = await syncOneCampaign(supabase, campaign, segmentIdToTag)
      grandTotalOpeners += totalOpeners
      totalNewOpeners += newOpeners
      totalNewClickers += newClickers
      totalUnmatched += unmatchedEmails
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
    totalOpeners: grandTotalOpeners,
    newOpeners: totalNewOpeners,
    newClickers: totalNewClickers,
    unmatchedEmails: totalUnmatched,
  }
}
