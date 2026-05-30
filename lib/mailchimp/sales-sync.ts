// Server-side only — never import this in client components
// Orchestrates the "Sync from Mailchimp" button logic for the Sales Dashboard.

import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  listCampaigns,
  listAudienceTags,
  listTagMembers,
  getCampaignSentTo,
  getCampaignOpenDetails,
  getCampaignActivity,
  getCampaignSubReports,
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
  totalOpeners: number   // confirmed openers (open_count > 0) across all child campaigns
  totalLeads: number     // total leads in the engagement map (may exceed openers when openers_only=false)
  newOpeners: number     // new sales_leads created (matched to SF customer, first time)
  newClickers: number
  unmatchedEmails: number
}

// Build a map of email → sf_customers.id.
// Emails live in sf_contact_emails (not sf_customer_contacts).
// We look up sf_contact_emails first to get the contact_id, then join to
// sf_customer_contacts to get customer_id.
// ilike matching is required because SF may store emails with mixed case while
// Mailchimp normalizes to lowercase.
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

    // Step 1: find contact_ids for these emails
    const { data: emailRows, error: emailErr } = await supabase
      .from('sf_contact_emails')
      .select('contact_id, email')
      .or(orFilter)
    if (emailErr) console.error('[sales-sync] sf_contact_emails query error:', emailErr)

    const contactRows = emailRows ?? []
    if (contactRows.length === 0) {
      console.log(`[sales-sync] email chunk ${i}–${i + chunk.length}: 0 matches in sf_contact_emails`)
      continue
    }

    // Step 2: resolve contact_id → customer_id
    const contactIds = [...new Set(contactRows.map(r => r.contact_id).filter(Boolean))]
    const { data: contactRows2, error: contactErr } = await supabase
      .from('sf_customer_contacts')
      .select('id, customer_id')
      .in('id', contactIds)
    if (contactErr) console.error('[sales-sync] sf_customer_contacts query error:', contactErr)

    const contactIdToCustomer = new Map((contactRows2 ?? []).map(c => [c.id, c.customer_id]))

    for (const row of contactRows) {
      if (row.email && row.contact_id) {
        const customerId = contactIdToCustomer.get(row.contact_id)
        if (customerId) map.set(row.email.toLowerCase(), customerId)
      }
    }

    console.log(`[sales-sync] email chunk ${i}–${i + chunk.length}: queried ${chunk.length} emails, got ${contactRows.length} email matches, ${map.size} total resolved so far`)
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
): Promise<{ totalOpeners: number; totalLeads: number; newOpeners: number; newClickers: number; unmatchedEmails: number }> {
  const campaignId = campaign.id
  const now = new Date().toISOString()

  // Campaign-level tag (from segment_opts — null when sent to whole audience)
  const tagName = resolveTagName(campaign, segmentIdToTag)

  // A/B test / multivariate campaigns: the parent campaign coordinates the send
  // but per-member activity (opens, clicks) lives on child campaigns.
  // Fetch child IDs first, then fetch all parent data in parallel,
  // then fetch child data sequentially (one child at a time) to stay under
  // Mailchimp's 10 simultaneous connection limit.
  const childIds = await getCampaignSubReports(campaignId)

  const [sentTo, activityAll, openDetails, clickers, report] = await Promise.all([
    getCampaignSentTo(campaignId),
    getCampaignActivity(campaignId),
    getCampaignOpenDetails(campaignId),
    getCampaignClickers(campaignId),
    getCampaignReport(campaignId),
  ])

  // Fetch each child's opener data sequentially to avoid rate limits.
  // Within each child we still fire email-activity + open-details in parallel
  // (only 2 concurrent requests, well within the 10-connection limit).
  const childActivityArrays: typeof activityAll[] = []
  const childOpenDetailArrays: typeof openDetails[] = []
  for (const childId of childIds) {
    const [childActivity, childOpenDetails] = await Promise.all([
      getCampaignActivity(childId),
      getCampaignOpenDetails(childId),
    ])
    childActivityArrays.push(childActivity)
    childOpenDetailArrays.push(childOpenDetails)
  }

  // Flatten child data into parent arrays
  const allActivity = [...activityAll, ...childActivityArrays.flat()]
  const allOpenDetails = [...openDetails, ...childOpenDetailArrays.flat()]

  // Build confirmed-opener map from all sources (parent + children).
  const confirmedOpenerMap = new Map<string, { opens_count: number; first_open: string | null; last_open: string | null }>()
  for (const a of [...allActivity, ...allOpenDetails]) {
    if (a.opens_count > 0) {
      const key = a.email_address.toLowerCase()
      const existing = confirmedOpenerMap.get(key)
      if (!existing || a.opens_count > existing.opens_count) {
        confirmedOpenerMap.set(key, { opens_count: a.opens_count, first_open: a.first_open, last_open: a.last_open })
      }
    }
  }
  console.log(`[sales-sync] campaign ${campaignId}: ${sentTo.length} recipients (sent-to), ${childIds.length} child campaigns, ${confirmedOpenerMap.size} confirmed openers`)

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

  // Fetch campaign settings (assigned rep + openers_only flag) before building leads.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: campaignRow } = await (supabase as any)
    .from('mc_campaigns')
    .select('assigned_to_user_id, openers_only')
    .eq('mailchimp_campaign_id', campaignId)
    .single()
  const campaignAssignedUserId: string | null = (campaignRow as any)?.assigned_to_user_id ?? null
  const openersOnly: boolean = (campaignRow as any)?.openers_only ?? false
  console.log(`[sales-sync] campaign ${campaignId}: assigned rep = ${campaignAssignedUserId ?? 'none'}, openers_only = ${openersOnly}`)

  // Build engagement map: all recipients from sent-to, with open data overlaid
  // from the confirmed-opener map where available.
  const recipients = sentTo.length > 0 ? sentTo : [...allActivity, ...allOpenDetails]
  console.log(`[sales-sync] campaign ${campaignId}: building leads from ${recipients.length} recipients`)

  const engagementMap = new Map<string, {
    first_opened_at: string | null
    last_opened_at: string | null
    open_count: number
    click_count: number
  }>()

  for (const a of recipients) {
    const email = a.email_address.toLowerCase()
    // When openers_only is set, skip anyone not in the confirmed-opener map
    if (openersOnly && !confirmedOpenerMap.has(email)) continue
    const confirmed = confirmedOpenerMap.get(email)
    engagementMap.set(email, {
      first_opened_at: confirmed?.first_open ?? a.first_open,
      last_opened_at: confirmed?.last_open ?? a.last_open,
      open_count: confirmed?.opens_count ?? a.opens_count,
      click_count: a.clicks_count,
    })
  }

  // Merge click-details for any clickers not already in the map
  for (const c of clickers) {
    const email = c.email_address.toLowerCase()
    const existing = engagementMap.get(email)
    if (existing) {
      existing.click_count = Math.max(existing.click_count, c.clicks)
    } else if (!openersOnly) {
      engagementMap.set(email, { first_opened_at: null, last_opened_at: null, open_count: 0, click_count: c.clicks })
    }
  }

  // Tag-based leads: when openers_only is false, add all tagged members as leads
  // so reps have the full audience to work from even without confirmed open data.
  if (!openersOnly) {
    for (const [email] of emailToTagName) {
      if (!engagementMap.has(email)) {
        engagementMap.set(email, { first_opened_at: null, last_opened_at: null, open_count: 0, click_count: 0 })
      }
    }
  }
  console.log(`[sales-sync] campaign ${campaignId}: ${engagementMap.size} total leads (${confirmedOpenerMap.size} confirmed openers, openers_only=${openersOnly})`)

  if (engagementMap.size === 0) {
    return { totalOpeners: 0, totalLeads: 0, newOpeners: 0, newClickers: 0, unmatchedEmails: 0 }
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
    return { totalOpeners: confirmedOpenerMap.size, totalLeads: engagementMap.size, newOpeners: 0, newClickers: 0, unmatchedEmails }
  }

  // Don't create leads unless a rep is assigned to this campaign.
  // Engagement data is still recorded in mc_campaign_engagement so it's
  // ready when the admin assigns a rep and triggers a re-sync.
  if (!campaignAssignedUserId) {
    console.log(`[sales-sync] campaign ${campaignId}: no assigned rep — skipping lead creation`)
    return { totalOpeners: confirmedOpenerMap.size, totalLeads: engagementMap.size, newOpeners: 0, newClickers: 0, unmatchedEmails }
  }

  const { data: existingLeads } = await supabase
    .from('sales_leads')
    .select('id, customer_id, open_count, click_count')
    .eq('mailchimp_campaign_id', campaignId)
    .in('customer_id', matchedCustomerIds)

  const existingByCustomer = new Map(existingLeads?.map(l => [l.customer_id, l]) ?? [])

  let newOpeners = 0
  let newClickers = 0

  for (const row of engagementRows) {
    if (!row.customer_id) continue
    const existing = existingByCustomer.get(row.customer_id)

    const leadTagName = emailToTagName.get(row.email) ?? tagName
    const autoAssignUserId = campaignAssignedUserId

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

  return { totalOpeners: confirmedOpenerMap.size, totalLeads: engagementMap.size, newOpeners, newClickers, unmatchedEmails }
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
  let grandTotalLeads = 0
  let totalNewOpeners = 0
  let totalNewClickers = 0
  let totalUnmatched = 0
  let campaignsSynced = 0
  let syncError: string | null = null

  try {
    // Process campaigns sequentially to avoid overwhelming Mailchimp rate limits
    for (const campaign of relevant) {
      const { totalOpeners, totalLeads, newOpeners, newClickers, unmatchedEmails } = await syncOneCampaign(supabase, campaign, segmentIdToTag, emailToTagName)
      grandTotalOpeners += totalOpeners
      grandTotalLeads += totalLeads
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
    totalLeads: grandTotalLeads,
    newOpeners: totalNewOpeners,
    newClickers: totalNewClickers,
    unmatchedEmails: totalUnmatched,
  }
}
