// Server-side only — never import this in client components
// All calls are read-only GETs against the Mailchimp Marketing API.

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
    segment_text?: string // human-readable description of the segment/tag used
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

const CAMPAIGN_FIELDS = [
  'campaigns.id',
  'campaigns.type',
  'campaigns.send_time',
  'campaigns.emails_sent',
  'campaigns.settings.subject_line',
  'campaigns.settings.from_name',
  'campaigns.recipients.list_id',
  'campaigns.recipients.segment_text',
  'campaigns.report_summary',
  'total_items',
].join(',')

// Returns all sent campaigns for the configured audience, newest first.
// Paginates internally (Mailchimp max 1000/page).
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
      fields: CAMPAIGN_FIELDS,
      sort_field: 'send_time',
      sort_dir: 'DESC',
    })
    if (!res.ok) break
    const data = await res.json() as { campaigns: McRawCampaign[]; total_items: number }
    results.push(...(data.campaigns ?? []))
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
  const res = await mcGet(`/reports/${campaignId}`, {
    fields: 'id,emails_sent,opens,clicks',
  })
  if (!res.ok) return null
  return res.json() as Promise<McRawReport>
}

// ─────────────────────────────────────────────────────────────
// Open detail — who opened (Mailchimp's filtered unique openers)
// ─────────────────────────────────────────────────────────────

const OPENER_FIELDS = [
  'members.email_address',
  'members.opens_count',
  'members.first_open',
  'members.last_open',
  'total_items',
].join(',')

export async function getCampaignOpeners(campaignId: string): Promise<McRawOpener[]> {
  if (!isConfigured()) return []

  const PAGE = 1000
  const results: McRawOpener[] = []
  let offset = 0

  while (true) {
    const res = await mcGet(`/reports/${campaignId}/open-details`, {
      count: PAGE,
      offset,
      fields: OPENER_FIELDS,
    })
    if (!res.ok) break
    const data = await res.json() as { members: McRawOpener[]; total_items: number }
    results.push(...(data.members ?? []))
    if (results.length >= data.total_items) break
    offset += PAGE
  }

  return results
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
  const res = await mcGet(`/reports/${campaignId}/click-details`, {
    fields: 'urls_clicked.id,urls_clicked.url,urls_clicked.total_clicks,urls_clicked.unique_clicks',
    count: 1000,
  })
  if (!res.ok) return []
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
