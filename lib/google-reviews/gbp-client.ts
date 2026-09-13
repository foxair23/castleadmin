// Google Business Profile API client — Reviews endpoint (v4)
//
// To activate:
//   GOOGLE_CLIENT_ID          — OAuth 2.0 client ID
//   GOOGLE_CLIENT_SECRET      — OAuth 2.0 client secret
//   GOOGLE_OAUTH_REFRESH_TOKEN — long-lived refresh token (store in Vercel env)
//   GOOGLE_BUSINESS_ACCOUNT_ID  — GBP account segment, e.g. "accounts/123456789"
//   GOOGLE_BUSINESS_LOCATION_ID — location segment, e.g. "locations/987654321"
//
// When any of the five vars are absent `isConfigured()` is false: reads fall back
// to mock data and `postReviewReply` reports a mock success without calling Google.

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

export async function refreshAccessToken(): Promise<string> {
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

export type PostReplyResult =
  | { ok: true; replyUpdatedAt: string | null; mock?: true }
  | { ok: false; status: number; error: string }

/**
 * Create or replace the owner reply on one review (the reply object on Google is
 * text only). Never throws on an API error — the dispatcher decides whether to
 * retry. Requires the `business.manage` scope on the refresh token.
 */
export async function postReviewReply(googleReviewId: string, comment: string): Promise<PostReplyResult> {
  if (!isConfigured()) return { ok: true, replyUpdatedAt: new Date().toISOString(), mock: true }
  let token: string
  try { token = await refreshAccessToken() } catch (e) { return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) } }
  const location = `${process.env.GOOGLE_BUSINESS_ACCOUNT_ID}/${process.env.GOOGLE_BUSINESS_LOCATION_ID}`
  const url = `${GBP_BASE}/${location}/reviews/${encodeURIComponent(googleReviewId)}/reply`
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment }),
    })
    if (!res.ok) return { ok: false, status: res.status, error: `GBP reply PUT failed ${res.status}: ${(await res.text()).slice(0, 500)}` }
    const json = await res.json().catch(() => ({})) as { updateTime?: string }
    return { ok: true, replyUpdatedAt: json.updateTime ?? null }
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface LocalPostInput {
  summary: string
  /** Public JPEG/PNG URLs, at most 2 in our use. */
  mediaUrls: string[]
  callToAction?: { actionType: 'LEARN_MORE' | 'CALL'; url?: string }
}
export type CreatePostResult =
  | { ok: true; name: string | null; state: string | null; mock?: true }
  | { ok: false; status: number; error: string }

/** Publish a STANDARD post on the configured profile (v4 localPosts). Never throws on an API error. */
export async function createLocalPost(input: LocalPostInput): Promise<CreatePostResult> {
  if (!isConfigured()) return { ok: true, name: `mock/localPosts/${Date.now()}`, state: 'LIVE', mock: true }
  let token: string
  try { token = await refreshAccessToken() } catch (e) { return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) } }
  const location = `${process.env.GOOGLE_BUSINESS_ACCOUNT_ID}/${process.env.GOOGLE_BUSINESS_LOCATION_ID}`
  const body: Record<string, unknown> = {
    languageCode: 'en-US',
    topicType: 'STANDARD',
    summary: input.summary,
    media: input.mediaUrls.slice(0, 2).map(u => ({ mediaFormat: 'PHOTO', sourceUrl: u })),
  }
  if (input.callToAction) {
    body.callToAction = input.callToAction.actionType === 'CALL'
      ? { actionType: 'CALL' }
      : { actionType: 'LEARN_MORE', url: input.callToAction.url }
  }
  try {
    const res = await fetch(`${GBP_BASE}/${location}/localPosts`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    if (!res.ok) return { ok: false, status: res.status, error: `GBP localPosts POST failed ${res.status}: ${(await res.text()).slice(0, 500)}` }
    const json = await res.json().catch(() => ({})) as { name?: string; state?: string }
    return { ok: true, name: json.name ?? null, state: json.state ?? null }
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) }
  }
}
