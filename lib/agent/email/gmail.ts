import type { SupabaseClient } from '@supabase/supabase-js'
import { appUrl } from '@/lib/config/domains'
import type { InboundEmail, EmailAddress } from './types'
import { unwrapGroupRelay } from './relay'

// Gmail for Cassie's mailbox (PRD §4). Read + send only, on ONE account. Raw REST
// (same style as the Business Profile client) — no googleapis dependency.
//
//   • Auth: Google OAuth. Client id/secret are the existing GOOGLE_CLIENT_ID/SECRET;
//     the refresh token for the agent mailbox is granted once via the admin
//     "Connect Gmail" flow and stored in agent_gmail_credentials (env fallback).
//   • Fetch: incremental via the History API from the last stored historyId; first run
//     (or an expired historyId) falls back to a bounded search of recent INBOX mail.
//   • Send: RFC 822 message, base64url, posted with the Gmail threadId + In-Reply-To /
//     References so the reply lands in the partner's existing thread.

export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send']
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const API = 'https://gmail.googleapis.com/gmail/v1/users/me'

export function gmailRedirectUri(): string { return `${appUrl()}/api/cassie/gmail/callback` }

// Cassie's OAuth client lives in a Workspace-owned Google Cloud project (consent screen
// "Internal": no verification review, refresh tokens never expire). GMAIL_CLIENT_ID /
// GMAIL_CLIENT_SECRET name it; the reviews client (GOOGLE_CLIENT_*) is the fallback so an
// existing setup keeps working.
export const gmailClientId = (): string => process.env.GMAIL_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || ''
export const gmailClientSecret = (): string => process.env.GMAIL_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || ''
export function isGoogleOAuthConfigured(): boolean {
  return !!(gmailClientId() && gmailClientSecret())
}

export class GmailAuthError extends Error { constructor(msg: string) { super(msg); this.name = 'GmailAuthError' } }

// ── Credentials ─────────────────────────────────────────────────────────────

export interface GmailCredential { email: string; refresh_token: string; scopes: string[]; granted_at: string | null; source: 'db' | 'env' }

export async function loadGmailCredential(db: SupabaseClient): Promise<GmailCredential | null> {
  const { data } = await db.from('agent_gmail_credentials').select('email, refresh_token, scopes, granted_at, revoked_at').eq('id', 1).maybeSingle()
  if (data && !data.revoked_at) return { email: data.email as string, refresh_token: data.refresh_token as string, scopes: (data.scopes as string[]) ?? [], granted_at: data.granted_at as string, source: 'db' }
  if (process.env.GMAIL_REFRESH_TOKEN) return { email: process.env.GMAIL_ACCOUNT_EMAIL ?? 'unknown', refresh_token: process.env.GMAIL_REFRESH_TOKEN, scopes: GMAIL_SCOPES, granted_at: null, source: 'env' }
  return null
}

export function authorizeUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: gmailClientId(), redirect_uri: gmailRedirectUri(), response_type: 'code',
    scope: GMAIL_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', state,
  })
  return `${AUTH_URL}?${p}`
}

export async function exchangeCode(code: string): Promise<{ refresh_token: string; access_token: string; scope: string }> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: gmailClientId(), client_secret: gmailClientSecret(), redirect_uri: gmailRedirectUri(), grant_type: 'authorization_code' }),
  })
  const j = await res.json() as { refresh_token?: string; access_token?: string; scope?: string; error?: string; error_description?: string }
  if (!res.ok || !j.access_token) throw new GmailAuthError(`Google token exchange failed: ${j.error ?? res.status} ${j.error_description ?? ''}`.trim())
  if (!j.refresh_token) throw new GmailAuthError('Google did not return a refresh token. Remove Castle Admin under the Google account\'s "Third-party access" and connect again.')
  return { refresh_token: j.refresh_token, access_token: j.access_token, scope: j.scope ?? '' }
}

let accessCache: { token: string; exp: number; key: string } | null = null

export async function getAccessToken(cred: GmailCredential): Promise<string> {
  const key = cred.refresh_token.slice(-12)
  if (accessCache && accessCache.key === key && Date.now() < accessCache.exp - 60_000) return accessCache.token
  const res = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: gmailClientId(), client_secret: gmailClientSecret(), refresh_token: cred.refresh_token, grant_type: 'refresh_token' }),
  })
  const j = await res.json() as { access_token?: string; expires_in?: number; error?: string; error_description?: string }
  if (!res.ok || !j.access_token) throw new GmailAuthError(`Gmail authorization failed: ${j.error ?? res.status} ${j.error_description ?? ''}`.trim())
  accessCache = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000, key }
  return j.access_token
}

async function gapi<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
  if (res.status === 401 || res.status === 403) throw new GmailAuthError(`Gmail API ${res.status} on ${path.split('?')[0]}: ${await res.text()}`)
  if (!res.ok) throw new Error(`Gmail API ${res.status} on ${init.method ?? 'GET'} ${path.split('?')[0]}: ${(await res.text()).slice(0, 300)}`)
  return res.json() as Promise<T>
}

/** Who this token belongs to — used to refuse a grant from the wrong Google account. */
export async function profileEmail(accessToken: string): Promise<{ emailAddress: string; historyId: string }> {
  const res = await fetch(`${API}/profile`, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw new GmailAuthError(`Gmail profile lookup failed (${res.status})`)
  return res.json() as Promise<{ emailAddress: string; historyId: string }>
}

// ── Fetch ───────────────────────────────────────────────────────────────────

interface GmailHeader { name: string; value: string }
interface GmailPart { mimeType?: string; body?: { data?: string; size?: number }; parts?: GmailPart[]; headers?: GmailHeader[] }
interface GmailMessage { id: string; threadId: string; labelIds?: string[]; internalDate?: string; payload?: GmailPart & { headers?: GmailHeader[] } }

const b64url = (s: string) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')

export function parseAddressList(v: string | undefined): EmailAddress[] {
  if (!v) return []
  const out: EmailAddress[] = []
  for (const part of v.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(part) || /^\s*([^\s<>]+@[^\s<>]+)\s*$/.exec(part)
    if (!m) continue
    if (m.length === 3) out.push({ addr: m[2].trim().toLowerCase(), name: (m[1] ?? '').trim() || null })
    else out.push({ addr: m[1].trim().toLowerCase(), name: null })
  }
  return out
}

function findPart(p: GmailPart | undefined, mime: string): GmailPart | null {
  if (!p) return null
  if (p.mimeType === mime && p.body?.data) return p
  for (const c of p.parts ?? []) { const f = findPart(c, mime); if (f) return f }
  return null
}

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d|blockquote)>/gi, "\n")
    .replace(/<blockquote[^>]*>/gi, '\n> ').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function toInboundEmail(m: GmailMessage): InboundEmail {
  const headers: Record<string, string> = {}
  for (const h of m.payload?.headers ?? []) headers[h.name.toLowerCase()] = h.value
  const plain = findPart(m.payload, 'text/plain'), html = findPart(m.payload, 'text/html')
  const body = plain?.body?.data ? unb64url(plain.body.data) : html?.body?.data ? htmlToText(unb64url(html.body.data)) : ''
  const from = parseAddressList(headers['from'])[0] ?? { addr: '', name: null }
  return unwrapGroupRelay({
    source: 'gmail', gmailMessageId: m.id, gmailThreadId: m.threadId,
    internetMessageId: headers['message-id'] ?? null, inReplyTo: headers['in-reply-to'] ?? null,
    references: (headers['references'] ?? '').split(/\s+/).filter(Boolean),
    from, to: parseAddressList(headers['to']), cc: parseAddressList(headers['cc']),
    subject: headers['subject'] ?? '', bodyText: body, headers,
    receivedAt: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : new Date().toISOString(),
  })
}

export interface FetchResult { emails: InboundEmail[]; historyId: string; mode: 'history' | 'search' }

/** New INBOX messages since `sinceHistoryId` (or the last day when there is none). */
export async function fetchNewMessages(token: string, sinceHistoryId: string | null, opts: { max?: number } = {}): Promise<FetchResult> {
  const max = opts.max ?? 25
  const ids = new Set<string>()
  let mode: FetchResult['mode'] = 'history'
  let historyId = sinceHistoryId ?? ''
  if (sinceHistoryId) {
    try {
      let pageToken: string | undefined
      do {
        const q = new URLSearchParams({ startHistoryId: sinceHistoryId, historyTypes: 'messageAdded', labelId: 'INBOX', maxResults: '100' })
        if (pageToken) q.set('pageToken', pageToken)
        const h = await gapi<{ history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>; historyId: string; nextPageToken?: string }>(token, `/history?${q}`)
        for (const rec of h.history ?? []) for (const a of rec.messagesAdded ?? []) ids.add(a.message.id)
        historyId = h.historyId ?? historyId
        pageToken = h.nextPageToken
      } while (pageToken && ids.size < max * 4)
    } catch (e) {
      // 404 = historyId too old (Gmail keeps ~a week). Fall back to a search.
      if (!(e instanceof Error) || !/404/.test(e.message)) throw e
      mode = 'search'
    }
  } else mode = 'search'
  if (mode === 'search') {
    const q = new URLSearchParams({ q: 'in:inbox newer_than:1d', maxResults: String(max) })
    const l = await gapi<{ messages?: Array<{ id: string }> }>(token, `/messages?${q}`)
    for (const m of l.messages ?? []) ids.add(m.id)
    const prof = await profileEmail(token)
    historyId = prof.historyId
  }
  const emails: InboundEmail[] = []
  for (const id of [...ids].slice(0, max)) {
    const m = await gapi<GmailMessage>(token, `/messages/${id}?format=full`)
    emails.push(toInboundEmail(m))
  }
  emails.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
  return { emails, historyId, mode }
}

// ── Send ────────────────────────────────────────────────────────────────────

export interface OutboundEmail {
  fromName: string
  fromAddr: string
  to: string
  cc: string[]
  replyTo: string
  subject: string
  text: string
  inReplyTo: string | null
  references: string[]
  gmailThreadId: string | null
}

const encWord = (s: string) => /^[\x20-\x7e]*$/.test(s) ? s.replace(/"/g, '') : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`

export function buildRfc822(o: OutboundEmail): string {
  const lines = [
    `From: "${encWord(o.fromName)}" <${o.fromAddr}>`,
    `To: ${o.to}`,
    ...(o.cc.length ? [`Cc: ${o.cc.join(', ')}`] : []),
    `Reply-To: ${o.replyTo}`,
    `Subject: ${encWord(o.subject)}`,
    ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`] : []),
    ...(o.references.length ? [`References: ${o.references.join(' ')}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    'X-Castle-Agent: cassie',
    '',
    o.text,
  ]
  return lines.join('\r\n')
}

export async function sendMessage(token: string, o: OutboundEmail): Promise<{ id: string; threadId: string }> {
  const body: Record<string, string> = { raw: b64url(buildRfc822(o)) }
  if (o.gmailThreadId) body.threadId = o.gmailThreadId
  return gapi<{ id: string; threadId: string }>(token, '/messages/send', { method: 'POST', body: JSON.stringify(body) })
}
