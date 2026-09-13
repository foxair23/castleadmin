import type { SupabaseClient } from '@supabase/supabase-js'
import { ensureShortLink, shortCode, shortUrl } from '@/lib/short-links'
import { appUrl } from '@/lib/config/domains'

// Per-customer Google review links (PRD §3). Short-link codes are derived from
// the target URL, so every customer used to get the same code and clicks could
// not be attributed. Each survey now gets its own target — the app's /r/<surveyId>
// bouncer — which stamps review_link_clicked_at and redirects to the Google
// review URL. Same precedent as the LeadGen outreach link.

export const reviewLinkTarget = (surveyId: string): string => `${appUrl()}/r/${surveyId}`

/** The customer-facing short URL for this survey's review link; stores the code on the survey once. */
export async function ensureReviewLink(db: SupabaseClient, surveyId: string): Promise<string> {
  const target = reviewLinkTarget(surveyId)
  const url = await ensureShortLink(target)
  const code = shortCode(target)
  await db.from('csat_surveys').update({ review_short_code: code }).eq('id', surveyId).is('review_short_code', null)
  return url
}

export const reviewLinkUrlFor = (code: string): string => shortUrl(code)
