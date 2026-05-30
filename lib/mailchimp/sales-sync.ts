// Server-side only — never import this in client components
// Orchestrates the "Sync from Mailchimp" button logic for the Sales Dashboard.

import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  listCampaigns,
  listAudienceTags,
  listTagMembers,
  getCampaignActivity,
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
  segmentIdToTag: Map<number, string>,
  emailToTagName: Map<string, string>
): Promise<{ totalOpeners: number; newOpeners: number; newClickers: number; unmatchedEmails: number }> {
  const campaignId = campaign.id
  const now = new Date().toISOString()

  // Campaign-level tag (from segment_opts — null when sent to whole audience)
  const tagName = resolveTagName(campaign, segmentIdToTag)

  // Fetch all recipient activity and report in parallel
  const [allActivity, clickers, report] = await Promise.all([
    getCampaignActivity(campaignId),
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
        total_clicks: clickers.length > 0
          ? clickers.length
          : (report?.clicks?.unique_clicks ?? campaign.report_summary?.unique_clicks ?? null),
        is_tracked: true,
        last_synced_at: now,
      },
      { onConflict: 'mailchimp_campaign_id' }
    )

  const taggedCount = allActivity.filter(a => emailToTagName.has(a.email_address.toLowerCase())).length
  console.log(`[sales-sync] campaign ${campaignId}: ${allActivity.length} recipients, ${taggedCount} tagged, ${clickers.length} clickers`)

  if (allActivity.length === 0 && clickers.length === 0) {
    return { totalOpeners: 0, newOpeners: 0, newClickers: 0, unmatchedEmails: 0 }
  }

  // Build engagement map:
  // - Tagged members: always included regardless of engagement
  //   (the tag signals "I pushed this contact for follow-up")
  // - Untagged members: only included if they opened or clicked
  const engagementMap = new Map<string, {
    first_opened_at: string | null
    last_opened_at: string | null
    open_count: number
    click_count: number
  }>()

  for (const a of allActivity) {
    const email = a.email_address.toLowerCase()
    const isTagged = emailToTagName.has(email)
    if (!isTagged && a.opens_count === 0 && a.clicks_count === 0) continue
    engagementMap.set(email, {
      first_opened_at: a.first_open,
      last_opened_at: a.last_open,
      open_count: a.opens_count,
      click_count: a.clicks_count,
    })
  }

  // Merge click-details for any clickers not already in the map
  for (const c of clickers) {
    const email = c.email_address.toLowerCase()
    const existing = engagementMap.get(email)
    if (existing) {
      existing.click_count = Math.max(existing.click_count, c.clicks)
    } else {
      engagementMap.set(email, { first_opened_at: null, last_opened_at: null, open_count: 0, click_count: c.clicks })
    }
  }

  // Resolve all emails to customer IDs in one pass
  const allEmails = Array.from(engagementMap.keys())
  const emailToCustomerId = await resolveEmailsToCustomerIds(supabase, allEmails)

  // Upsert mc_campaign_engagement rows
  const engagementRows = Array.from(engagementMap.entries()).map(([email, e]) => ({
    mailchimp_campaign_id: campaignId,
    email,
    customer_id: emailToCustomerId.get(email) ?? null,
    first_opened_at: e.first_opened_at,
    last_opened_at: e.last_opened_at,
    open_count: e.open_count,
    click_count: e.click_count,
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

  console.log(`[sales-sync] campaign ${campaignId}: ${matchedCustomerIds.length} resolved to SF customers, ${unmatchedEmails} unmatched`)

  if (matchedCustomerIds.length === 0) {
    return { totalOpeners: engagementMap.size, newOpeners: 0, newClickers: 0, unmatchedEmails }
  }

  const { data: existingLeads } = await supabase
    .from('sales_leads')
    .select('id, customer_id, open_count, click_count')
    .eq('mailchimp_campaign_id', campaignId)
    .in('customer_id', matchedCustomerIds)

  const existingByCustomer = new Map(existingLeads?.map(l => [l.customer_id, l]) ?? [])

  // Pre-fetch all tag→assignee rules so we can auto-assign per lead based on their tag
  const { data: tagRules } = await supabase
    .from('mc_tag_assignments')
    .select('tag_name, assigned_to_user_id')
  const tagAssignmentMap = new Map(tagRules?.map(r => [r.tag_name, r.assigned_to_user_id]) ?? [])

  let newOpeners = 0
  let newClickers = 0

  for (const row of engagementRows) {
    if (!row.customer_id) continue
    const existing = existingByCustomer.get(row.customer_id)

    // Per-email tag: use the Mailchimp member tag the customer was pushed with.
    // Falls back to the campaign-level segment tag (which may be null for whole-audience sends).
    const leadTagName = emailToTagName.get(row.email) ?? tagName
    const autoAssignUserId = leadTagName ? (tagAssignmentMap.get(leadTagName) ?? null) : null

    if (!existing) {
      // New lead
      newOpeners++
      if (row.click_count > 0) newClickers++

      await supabase.from('sales_leads').insert({
        customer_id: row.customer_id,
        mailchimp_campaign_id: campaignId,
        tag_name: leadTagName,
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

  return { totalOpeners: engagementMap.size, newOpeners, newClickers, unmatchedEmails }
}

export async function runMailchimpSalesSync(triggeredByUserId: string): Promise<SalesSyncResult> {
  const supabase = db()
  const now = new Date().toISOString()

  // Fetch all audience tags (static segments).
  // Used for two purposes:
  //   1. segmentIdToTag: resolve campaign segment_opts ID → tag name (for segment-targeted campaigns)
  //   2. emailToTagName: map each member's email to their Mailchimp tag (for whole-audience campaigns)
  const audienceTags = await listAudienceTags()
  const segmentIdToTag = new Map(audienceTags.map(t => [t.id, t.name]))

  // Build email → tag name from Mailchimp member tags.
  // This is the primary tag source for leads: when a campaign is sent to the whole
  // audience, each opener/clicker is tagged with whatever tag they were pushed with,
  // not the campaign's segment target (which is absent for whole-audience sends).
  const emailToTagName = new Map<string, string>()
  for (const tag of audienceTags) {
    const members = await listTagMembers(tag.id)
    console.log(`[sales-sync] tag "${tag.name}" (${tag.id}): ${members.length} members`)
    for (const email of members) {
      if (!emailToTagName.has(email)) {
        emailToTagName.set(email, tag.name)
      }
    }
  }
  console.log(`[sales-sync] emailToTagName: ${emailToTagName.size} total tagged members`)

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
      const { totalOpeners, newOpeners, newClickers, unmatchedEmails } = await syncOneCampaign(supabase, campaign, segmentIdToTag, emailToTagName)
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
