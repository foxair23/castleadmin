// Google Business Profile API client — Reviews endpoint (v4)
//
// To activate:
//   GOOGLE_CLIENT_ID          — OAuth 2.0 client ID
//   GOOGLE_CLIENT_SECRET      — OAuth 2.0 client secret
//   GOOGLE_OAUTH_REFRESH_TOKEN — long-lived refresh token (store in Vercel env)
//   GOOGLE_BUSINESS_ACCOUNT_ID  — GBP account segment, e.g. "accounts/123456789"
//   GOOGLE_BUSINESS_LOCATION_ID — location segment, e.g. "locations/987654321"
//
// When any of the five vars are absent the client returns `null` from
// `isConfigured()` and callers fall back to mock data.

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GBP_BASE  = 'https://mybusiness.googleapis.com/v4'

export interface GbpReview {
  googleReviewId: string       // last path segment of the GBP "name" field
  reviewerName:   string | null
  starRating:     1 | 2 | 3 | 4 | 5
  comment:        string | null
  createdAtGoogle: string      // ISO timestamp
  updatedAtGoogle: string      // ISO timestamp
  replyText:       string | null
  replyUpdatedAt:  string | null
  rawPayload:      Record<string, unknown>
}

const STAR_MAP: Record<string, 1 | 2 | 3 | 4 | 5> = {
  ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5,
}

export function isConfigured(): boolean {
  return !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN &&
    process.env.GOOGLE_BUSINESS_ACCOUNT_ID &&
    process.env.GOOGLE_BUSINESS_LOCATION_ID
  )
}

async function refreshAccessToken(): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN!,
      grant_type:    'refresh_token',
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`OAuth token refresh failed ${res.status}: ${body}`)
  }
  const json = await res.json()
  return json.access_token as string
}

function normalizeReview(raw: Record<string, unknown>): GbpReview {
  const name = raw.name as string
  const googleReviewId = name.split('/').pop() ?? name

  const reviewer = raw.reviewer as Record<string, unknown> | undefined
  const reply    = raw.reviewReply as Record<string, unknown> | undefined

  return {
    googleReviewId,
    reviewerName:    (reviewer?.displayName as string | undefined) ?? null,
    starRating:      STAR_MAP[(raw.starRating as string) ?? ''] ?? 1,
    comment:         (raw.comment as string | undefined) ?? null,
    createdAtGoogle: raw.createTime as string,
    updatedAtGoogle: raw.updateTime as string,
    replyText:       (reply?.comment as string | undefined) ?? null,
    replyUpdatedAt:  (reply?.updateTime as string | undefined) ?? null,
    rawPayload:      raw,
  }
}

/** Fetch all reviews for the configured location, handling GBP pagination. */
export async function fetchAllReviews(): Promise<GbpReview[]> {
  const token    = await refreshAccessToken()
  const location = `${process.env.GOOGLE_BUSINESS_ACCOUNT_ID}/${process.env.GOOGLE_BUSINESS_LOCATION_ID}`
  const out: GbpReview[] = []
  let pageToken: string | undefined

  for (;;) {
    const url = new URL(`${GBP_BASE}/${location}/reviews`)
    url.searchParams.set('pageSize', '50')
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`GBP reviews fetch failed ${res.status}: ${body}`)
    }

    const json = await res.json() as { reviews?: unknown[]; nextPageToken?: string }
    for (const r of (json.reviews ?? []) as Record<string, unknown>[]) {
      out.push(normalizeReview(r))
    }
    if (!json.nextPageToken) break
    pageToken = json.nextPageToken
  }

  return out
}
