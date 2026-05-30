// Server-side only — never import this in client components
// All calls are read-only GETs against the Mailchimp Marketing API.

import crypto from 'crypto'

const API_KEY = process.env.MAILCHIMP_API_KEY ?? ''
const AUDIENCE_ID = process.env.MAILCHIMP_AUDIENCE_ID ?? ''
const SERVER_PREFIX = process.env.MAILCHIMP_SERVER_PREFIX ?? ''

function baseUrl() {
  return `https://${SERVER_PREFIX}.api.mailchimp.com/3.0`
}

function authHeader() {
  const encoded = Buffer.from(`anystring:${API_KEY}`).toString('base64')
  return `Basic ${encoded}`
}

async function mcGet(path: string, params?: Record<string, string | number>) {
  const url = new URL(`${baseUrl()}${path}`)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v))
    }
  }
  return fetch(url.toString(), {
    headers: { Authorization: authHeader() },
    cache: 'no-store',
  })
}

function isConfigured() {
  return Boolean(API_KEY && SERVER_PREFIX && AUDIENCE_ID)
}

// ─────────────────────────────────────────────────────────────
// Types — shaped to mirror what the Mailchimp API returns
// ─────────────────────────────────────────────────────────────

export interface McRawCampaign {
  id: string
  type: string
  send_time: string       // ISO datetime; empty string if not yet sent
  emails_sent: number
  settings: {
    subject_line: string
    from_name: string
  }
  recipients: {
    list_id: string
    segment_text?: string
    segment_opts?: {
      saved_segment_id?: number
      match?: string
      conditions?: Array<{
        condition_type: string
        field?: string
        op?: string
        value?: number | string | string[]
      }>
    }
  }
  report_summary?: {
    opens: number
    unique_opens: number
    clicks: number
    unique_clicks: number
    open_rate: number
    click_rate: number
  }
}

export interface McRawReport {
  id: string
  emails_sent: number
  opens: {
    opens_total: number
    unique_opens: number    // Mailchimp's filtered count (excludes known MPP)
    open_rate: number
  }
  clicks: {
    clicks_total: number
    unique_clicks: number
    click_rate: number
  }
}

export interface McRawOpener {
  email_address: string
  opens_count: number
  first_open: string       // ISO datetime
  last_open?: string       // ISO datetime
}

export interface McRawClicker {
  email_address: string
  clicks: number           // total clicks across all links in the campaign
}

// ─────────────────────────────────────────────────────────────
// Campaign listing
// ─────────────────────────────────────────────────────────────

// Returns all sent campaigns for the configured audience, newest first.
// Paginates internally (Mailchimp max 1000/page).
// No `fields` filter — Mailchimp silently strips nested objects like
// recipients.segment_opts when any field filter is present, even when the
// parent object (recipients) is requested as a whole.
export async function listCampaigns(): Promise<McRawCampaign[]> {
  if (!isConfigured()) return []

  const PAGE = 1000
  const results: McRawCampaign[] = []
  let offset = 0

  while (true) {
    const res = await mcGet('/campaigns', {
      list_id: AUDIENCE_ID,
      status: 'sent',
      count: PAGE,
      offset,
      sort_field: 'send_time',
      sort_dir: 'DESC',
    })
    if (!res.ok) break
    const data = await res.json() as { campaigns: McRawCampaign[]; total_items: number }
    const page = data.campaigns ?? []
    console.log(`[mailchimp] listCampaigns offset=${offset}: ${page.length} campaigns, total_items=${data.total_items}`)
    if (page.length > 0) {
      console.log(`[mailchimp] listCampaigns first campaign recipients:`, JSON.stringify(page[0].recipients))
    }
    results.push(...page)
    if (results.length >= data.total_items) break
    offset += PAGE
  }

  return results
}

// ─────────────────────────────────────────────────────────────
// Campaign report (summary stats)
// ─────────────────────────────────────────────────────────────

export async function getCampaignReport(campaignId: string): Promise<McRawReport | null> {
  if (!isConfigured()) return null
  const res = await mcGet(`/reports/${campaignId}`)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.error(`[mailchimp] report ${campaignId} HTTP ${res.status}: ${body}`)
    return null
  }
  return res.json() as Promise<McRawReport>
}

// ─────────────────────────────────────────────────────────────
// Open detail — who opened (Mailchimp's filtered unique openers)
// ─────────────────────────────────────────────────────────────

// email-activity returns per-member activity for everyone who had any interaction
// with the campaign (open, click, bounce, unsubscribe), including archived/cleaned
// members that open-details excludes. We filter client-side for action === 'open'.
interface McEmailActivity {
  email_address: string
  activity: Array<{ action: string; timestamp: string }>
}

// Returns ALL campaign recipients with their open+click activity.
// Unlike the old open-details endpoint, email-activity includes archived/cleaned
// members. We do NOT filter to openers here — the caller decides inclusion logic
// (e.g. include tagged members regardless of opens).
export interface McRawActivity {
  email_address: string
  opens_count: number
  clicks_count: number
  first_open: string | null
  last_open: string | null
}

export async function getCampaignActivity(campaignId: string): Promise<McRawActivity[]> {
  if (!isConfigured()) return []

  const PAGE = 1000
  const results: McRawActivity[] = []
  let offset = 0
  let totalSeen = 0

  while (true) {
    const res = await mcGet(`/reports/${campaignId}/email-activity`, {
      count: PAGE,
      offset,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[mailchimp] email-activity ${campaignId} HTTP ${res.status}: ${body}`)
      break
    }
    const data = await res.json() as { emails: McEmailActivity[]; total_items: number }
    const emails = data.emails ?? []
    console.log(`[mailchimp] email-activity ${campaignId} offset=${offset}: ${emails.length} members, total_items=${data.total_items}`)

    for (const member of emails) {
      const opens = member.activity.filter(a => a.action === 'open')
      const clicks = member.activity.filter(a => a.action === 'click')
      const openTs = opens.map(o => o.timestamp).sort()
      results.push({
        email_address: member.email_address,
        opens_count: opens.length,
        clicks_count: clicks.length,
        first_open: openTs[0] ?? null,
        last_open: openTs[openTs.length - 1] ?? null,
      })
    }

    totalSeen += emails.length
    if (totalSeen >= (data.total_items ?? 0)) break
    offset += PAGE
  }

  const openerCount = results.filter(r => r.opens_count > 0).length
  console.log(`[mailchimp] email-activity ${campaignId}: ${results.length} recipients, ${openerCount} openers`)
  return results
}

// open-details returns Mailchimp's processed opener list — the SAME data shown
// in the dashboard "Opened" report and its CSV export, INCLUDING Apple MPP opens.
// This is the source of truth for "who opened".
//
// (email-activity, by contrast, omits MPP-generated open events, so for a
// privacy-protected campaign it reports 0 openers even when the dashboard shows
// 100+. That mismatch is why we resolve openers from open-details instead.)
interface McOpenDetailMember {
  email_address: string
  opens_count: number
  opens?: Array<{ timestamp: string }>
}

export async function getCampaignOpenDetails(campaignId: string): Promise<McRawActivity[]> {
  if (!isConfigured()) return []

  const PAGE = 1000
  const results: McRawActivity[] = []
  let offset = 0
  let totalSeen = 0

  while (true) {
    const res = await mcGet(`/reports/${campaignId}/open-details`, { count: PAGE, offset })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[mailchimp] open-details ${campaignId} HTTP ${res.status}: ${body}`)
      break
    }
    const raw = await res.json()
    const data = raw as { members: McOpenDetailMember[]; total_items: number }
    const members = data.members ?? []
    // Log full raw response on first page when members=0 so we can see every field Mailchimp returns
    if (offset === 0 && members.length === 0) {
      console.log(`[mailchimp] open-details ${campaignId} raw response:`, JSON.stringify(raw))
    }
    console.log(`[mailchimp] open-details ${campaignId} offset=${offset}: ${members.length} members, total_items=${data.total_items}`)

    for (const m of members) {
      const ts = (m.opens ?? []).map(o => o.timestamp).sort()
      results.push({
        email_address: m.email_address,
        opens_count: m.opens_count ?? ts.length,
        clicks_count: 0,
        first_open: ts[0] ?? null,
        last_open: ts[ts.length - 1] ?? null,
      })
    }

    totalSeen += members.length
    if (totalSeen >= (data.total_items ?? 0)) break
    offset += PAGE
  }

  console.log(`[mailchimp] open-details ${campaignId}: ${results.length} openers`)
  return results
}

// Check whether a specific subscriber opened a campaign, using the per-subscriber
// open-details endpoint: GET /reports/{campaign_id}/open-details/{subscriber_hash}
// The subscriber_hash is the MD5 of the lowercase email address.
// Used as a fallback when the bulk open-details list returns 0 (e.g. MPP campaigns).
export async function getSubscriberOpenDetail(
  campaignId: string,
  email: string
): Promise<McRawActivity | null> {
  if (!isConfigured()) return null
  const hash = crypto.createHash('md5').update(email.toLowerCase()).digest('hex')
  const res = await mcGet(`/reports/${campaignId}/open-details/${hash}`)
  if (!res.ok) {
    if (res.status === 404) return null  // subscriber didn't open (or isn't in campaign)
    const body = await res.text().catch(() => '')
    console.error(`[mailchimp] open-details/${hash} ${campaignId} HTTP ${res.status}: ${body}`)
    return null
  }
  const data = await res.json() as {
    email_address: string
    opens_count: number
    opens?: Array<{ timestamp: string }>
  }
  if (!data.opens_count) return null
  const ts = (data.opens ?? []).map(o => o.timestamp).sort()
  return {
    email_address: data.email_address,
    opens_count: data.opens_count,
    clicks_count: 0,
    first_open: ts[0] ?? null,
    last_open: ts[ts.length - 1] ?? null,
  }
}

// Check a batch of emails against the per-subscriber open-details endpoint.
// Runs up to 10 requests concurrently (Mailchimp's recommended max).
// Returns only the subscribers who actually opened.
export async function checkEmailsForCampaignOpens(
  campaignId: string,
  emails: string[]
): Promise<McRawActivity[]> {
  if (!isConfigured() || emails.length === 0) return []

  const CONCURRENCY = 10
  const openers: McRawActivity[] = []

  for (let i = 0; i < emails.length; i += CONCURRENCY) {
    const batch = emails.slice(i, i + CONCURRENCY)
    const results = await Promise.all(batch.map(e => getSubscriberOpenDetail(campaignId, e)))
    for (const r of results) {
      if (r) openers.push(r)
    }
  }

  console.log(`[mailchimp] per-subscriber open check ${campaignId}: ${openers.length} openers out of ${emails.length} checked`)
  return openers
}

// Kept for backward compatibility — delegates to getCampaignActivity and filters.
export async function getCampaignOpeners(campaignId: string): Promise<McRawOpener[]> {
  const activity = await getCampaignActivity(campaignId)
  return activity
    .filter(a => a.opens_count > 0)
    .map(a => ({
      email_address: a.email_address,
      opens_count: a.opens_count,
      first_open: a.first_open!,
      last_open: a.last_open ?? undefined,
    }))
}

// ─────────────────────────────────────────────────────────────
// Click detail — who clicked (collapsed across all links)
// Mailchimp exposes clicks per link then per member per link.
// We collapse to one entry per email with a total click count.
// ─────────────────────────────────────────────────────────────

interface McClickUrl {
  id: string
  url: string
  total_clicks: number
  unique_clicks: number
}

interface McClickMember {
  email_address: string
  clicks: number
}

async function getClickUrls(campaignId: string): Promise<McClickUrl[]> {
  // No fields filter — see getCampaignOpeners for why we avoid fields on collections.
  const res = await mcGet(`/reports/${campaignId}/click-details`, { count: 1000 })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.error(`[mailchimp] click-details ${campaignId} HTTP ${res.status}: ${body}`)
    return []
  }
  const data = await res.json() as { urls_clicked: McClickUrl[] }
  return data.urls_clicked ?? []
}

async function getMembersForClickUrl(campaignId: string, urlId: string): Promise<McClickMember[]> {
  const PAGE = 1000
  const results: McClickMember[] = []
  let offset = 0

  while (true) {
    const res = await mcGet(`/reports/${campaignId}/click-details/${urlId}/members`, {
      count: PAGE,
      offset,
      fields: 'members.email_address,members.clicks,total_items',
    })
    if (!res.ok) break
    const data = await res.json() as { members: McClickMember[]; total_items: number }
    results.push(...(data.members ?? []))
    if (results.length >= data.total_items) break
    offset += PAGE
  }

  return results
}

export async function getCampaignClickers(campaignId: string): Promise<McRawClicker[]> {
  if (!isConfigured()) return []

  const urls = await getClickUrls(campaignId)
  if (urls.length === 0) return []

  // Fetch all URL→member sets in parallel, then collapse by email
  const perUrl = await Promise.all(urls.map(u => getMembersForClickUrl(campaignId, u.id)))

  const totals = new Map<string, number>()
  for (const members of perUrl) {
    for (const m of members) {
      totals.set(m.email_address, (totals.get(m.email_address) ?? 0) + m.clicks)
    }
  }

  return Array.from(totals.entries()).map(([email_address, clicks]) => ({ email_address, clicks }))
}

// ─────────────────────────────────────────────────────────────
// Audience tags (static segments)
// Mailchimp represents tags as static segments. Fetching all of them
// lets us map a campaign's segment_opts.conditions[].value (segment ID)
// back to a human-readable tag name.
// ─────────────────────────────────────────────────────────────

export interface McAudienceTag {
  id: number
  name: string
}

export async function listAudienceTags(): Promise<McAudienceTag[]> {
  if (!isConfigured()) return []
  // No fields filter — avoids Mailchimp silently omitting data.
  // type=static returns tags (Mailchimp tags are static segments in the API).
  const res = await mcGet(`/lists/${AUDIENCE_ID}/segments`, {
    type: 'static',
    count: 1000,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.error(`[mailchimp] listAudienceTags HTTP ${res.status}: ${body}`)
    return []
  }
  const data = await res.json() as { segments: McAudienceTag[] }
  const tags = data.segments ?? []
  console.log(`[mailchimp] listAudienceTags: ${tags.length} tags:`, JSON.stringify(tags.map(t => ({ id: t.id, name: t.name }))))
  return tags
}

// Fetch all member email addresses belonging to a Mailchimp tag (static segment).
// Used to build an email → tag_name map so leads are tagged with the member's
// Mailchimp tag regardless of which segment the campaign was sent to.
export async function listTagMembers(tagId: number): Promise<string[]> {
  if (!isConfigured()) return []
  const PAGE = 1000
  const emails: string[] = []
  let offset = 0
  while (true) {
    const res = await mcGet(`/lists/${AUDIENCE_ID}/segments/${tagId}/members`, {
      count: PAGE,
      offset,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[mailchimp] listTagMembers tag=${tagId} HTTP ${res.status}: ${body}`)
      break
    }
    const data = await res.json() as { members: Array<{ email_address: string }>; total_items: number }
    const members = data.members ?? []
    emails.push(...members.map(m => m.email_address.toLowerCase()))
    if (emails.length >= (data.total_items ?? 0)) break
    offset += PAGE
  }
  return emails
}
