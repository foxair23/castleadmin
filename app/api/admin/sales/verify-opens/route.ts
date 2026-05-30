import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { listCampaigns, getCampaignOpenDetails } from '@/lib/mailchimp/report'

export const maxDuration = 60

// TEMPORARY verification endpoint.
// Proves the open-details API returns the same opener set as the Mailchimp
// dashboard "Opened" CSV export. Read-only; admin-only. Safe to delete after
// the comparison is confirmed.
//
// EXPECTED_HASH is the SHA-256 of the sorted, lowercased, de-duplicated opener
// emails from the CSV the user exported for the "1 Year Maintenance" campaign
// (102 unique emails). No PII is committed — only this fingerprint.
const EXPECTED_HASH = '8cfbe81c3c832f23fe644811846bcd29cd8bdd241bcb6379090a2765e9f65934'
const EXPECTED_COUNT = 102

function fingerprint(emails: string[]): { count: number; hash: string; sorted: string[] } {
  const sorted = [...new Set(emails.map(e => e.trim().toLowerCase()).filter(Boolean))].sort()
  const hash = createHash('sha256').update(sorted.join('\n')).digest('hex')
  return { count: sorted.length, hash, sorted }
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, is_active')
    .eq('id', user.id)
    .single()

  if (!profile?.is_active || profile.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Resolve the campaign: explicit ?campaignId=... wins, else match by subject.
  const url = new URL(req.url)
  let campaignId = url.searchParams.get('campaignId') ?? ''
  const subjectMatch = (url.searchParams.get('subject') ?? '1 Year Maintenance').toLowerCase()

  const campaigns = await listCampaigns()
  let matchedSubject: string | null = null
  if (!campaignId) {
    const hit = campaigns.find(c => (c.settings?.subject_line ?? '').toLowerCase().includes(subjectMatch))
    if (hit) { campaignId = hit.id; matchedSubject = hit.settings?.subject_line ?? null }
  } else {
    matchedSubject = campaigns.find(c => c.id === campaignId)?.settings?.subject_line ?? null
  }

  if (!campaignId) {
    return NextResponse.json({
      error: `No campaign found matching subject "${subjectMatch}". Pass ?campaignId=...`,
      availableCampaigns: campaigns.map(c => ({ id: c.id, subject: c.settings?.subject_line })),
    }, { status: 404 })
  }

  const openers = await getCampaignOpenDetails(campaignId)
  const apiEmails = openers.map(o => o.email_address)
  const fp = fingerprint(apiEmails)

  return NextResponse.json({
    campaignId,
    subject: matchedSubject,
    api: { count: fp.count, hash: fp.hash },
    csv: { count: EXPECTED_COUNT, hash: EXPECTED_HASH },
    match: fp.hash === EXPECTED_HASH && fp.count === EXPECTED_COUNT,
    // Full list returned to the authenticated admin only (not committed anywhere)
    // so any mismatch can be diffed against the CSV.
    apiEmails: fp.sorted,
  })
}
