import { createSign, createVerify, X509Certificate } from 'crypto'

// Google Chat, app-authenticated (PRD §11 "Technical implementation"). Raw REST + a
// service-account JWT, no googleapis dependency.
//
//   Env: GOOGLE_CHAT_SERVICE_ACCOUNT_JSON — the service account key JSON (raw or base64)
//        GOOGLE_CHAT_PROJECT_NUMBER      — audience of the events Google sends us
//
//   Posting uses scope chat.bot. Events arrive at /api/cassie/chat/events with a
//   Google-signed bearer token; verifyEventToken checks signature, issuer and audience.

const SCOPE = 'https://www.googleapis.com/auth/chat.bot'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API = 'https://chat.googleapis.com/v1'
const EVENT_ISSUER = 'chat@system.gserviceaccount.com'
const CERTS_URL = `https://www.googleapis.com/service_accounts/v1/metadata/x509/${EVENT_ISSUER}`

export function isChatConfigured(): boolean {
  return !!(process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_JSON && process.env.GOOGLE_CHAT_PROJECT_NUMBER)
}

interface ServiceAccount { client_email: string; private_key: string }
function serviceAccount(): ServiceAccount {
  const raw = process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_JSON ?? ''
  const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')
  const sa = JSON.parse(json) as ServiceAccount
  if (!sa.client_email || !sa.private_key) throw new Error('GOOGLE_CHAT_SERVICE_ACCOUNT_JSON is missing client_email/private_key')
  return sa
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

let cached: { token: string; exp: number } | null = null
export async function chatAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.exp - 60_000) return cached.token
  const sa = serviceAccount()
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }))
  const signer = createSign('RSA-SHA256'); signer.update(`${header}.${claims}`)
  const jwt = `${header}.${claims}.${b64url(signer.sign(sa.private_key))}`
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }) })
  const j = await res.json() as { access_token?: string; expires_in?: number; error?: string; error_description?: string }
  if (!res.ok || !j.access_token) throw new Error(`Google Chat auth failed: ${j.error ?? res.status} ${j.error_description ?? ''}`.trim())
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 }
  return j.access_token
}

async function capi<T>(path: string, init: RequestInit): Promise<T> {
  const token = await chatAccessToken()
  const res = await fetch(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
  if (!res.ok) throw new Error(`Google Chat API ${res.status} on ${init.method ?? 'GET'} ${path.split('?')[0]}: ${(await res.text()).slice(0, 300)}`)
  return res.json() as Promise<T>
}

// ── Cards ───────────────────────────────────────────────────────────────────

export interface CardButton { text: string; fn: string; params?: Record<string, string>; url?: string; primary?: boolean }
export interface CardSpec { header: string; subheader?: string; paragraphs: Array<{ label?: string; text: string }>; buttons?: CardButton[] }

/** Cards v2 JSON. Buttons are native widgets (PRD §11); no workaround. */
export function buildCard(cardId: string, c: CardSpec): Record<string, unknown> {
  const widgets: Record<string, unknown>[] = c.paragraphs.map(p => ({ decoratedText: { topLabel: p.label ?? '', text: p.text.slice(0, 3000), wrapText: true } }))
  if (c.buttons?.length) {
    widgets.push({ buttonList: { buttons: c.buttons.map(b => ({
      text: b.text, ...(b.primary ? { type: 'FILLED' } : {}),
      onClick: b.url ? { openLink: { url: b.url } } : { action: { function: b.fn, parameters: Object.entries(b.params ?? {}).map(([key, value]) => ({ key, value })) } },
    })) } })
  }
  return { cardId, card: { header: { title: c.header, subtitle: c.subheader ?? '' }, sections: [{ widgets }] } }
}

export interface PostedMessage { name: string; thread?: { name: string } }

/** Post a card (and optional fallback text) into a space, threaded by key. */
export async function postCard(space: string, threadKey: string, card: Record<string, unknown>, text?: string): Promise<PostedMessage> {
  const q = new URLSearchParams({ messageReplyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' })
  return capi<PostedMessage>(`/${space}/messages?${q}`, { method: 'POST', body: JSON.stringify({ text: text ?? '', cardsV2: [card], thread: { threadKey } }) })
}

export async function postText(space: string, threadKey: string, text: string): Promise<PostedMessage> {
  const q = new URLSearchParams({ messageReplyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' })
  return capi<PostedMessage>(`/${space}/messages?${q}`, { method: 'POST', body: JSON.stringify({ text, thread: { threadKey } }) })
}

/** Replace a card we posted earlier (e.g. buttons → "Working…" / "Approved by Jane"). */
export async function updateCard(messageName: string, card: Record<string, unknown>, text?: string): Promise<PostedMessage> {
  const q = new URLSearchParams({ updateMask: text != null ? 'cardsV2,text' : 'cardsV2' })
  return capi<PostedMessage>(`/${messageName}?${q}`, { method: 'PATCH', body: JSON.stringify({ ...(text != null ? { text } : {}), cardsV2: [card] }) })
}

// ── Inbound event verification ──────────────────────────────────────────────

let certCache: { at: number; certs: Record<string, string> } | null = null
async function issuerCerts(): Promise<Record<string, string>> {
  if (certCache && Date.now() - certCache.at < 6 * 3600_000) return certCache.certs
  const res = await fetch(CERTS_URL)
  if (!res.ok) throw new Error(`Could not fetch Google Chat signing certs (${res.status})`)
  const certs = await res.json() as Record<string, string>
  certCache = { at: Date.now(), certs }
  return certs
}

export function decodeJwt(token: string): { header: { kid?: string; alg?: string }; payload: { iss?: string; aud?: string; exp?: number } } | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const dec = (s: string) => JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    return { header: dec(parts[0]), payload: dec(parts[1]) }
  } catch { return null }
}

/** Google signs every event it sends us. Reject anything else outright. */
export async function verifyEventToken(authorization: string | null, audience = process.env.GOOGLE_CHAT_PROJECT_NUMBER): Promise<{ ok: true } | { ok: false; reason: string }> {
  const token = (authorization ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!token) return { ok: false, reason: 'no bearer token' }
  const d = decodeJwt(token)
  if (!d) return { ok: false, reason: 'malformed token' }
  if (d.header.alg !== 'RS256') return { ok: false, reason: `unexpected alg ${d.header.alg}` }
  if (d.payload.iss !== EVENT_ISSUER) return { ok: false, reason: `unexpected issuer ${d.payload.iss}` }
  if (!audience || d.payload.aud !== audience) return { ok: false, reason: 'audience mismatch' }
  if (!d.payload.exp || d.payload.exp * 1000 < Date.now()) return { ok: false, reason: 'expired' }
  const certs = await issuerCerts()
  const pem = d.header.kid ? certs[d.header.kid] : undefined
  if (!pem) return { ok: false, reason: 'unknown signing key' }
  const [h, p, sig] = token.split('.')
  const v = createVerify('RSA-SHA256'); v.update(`${h}.${p}`)
  const ok = v.verify(new X509Certificate(pem).publicKey, Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))
  return ok ? { ok: true } : { ok: false, reason: 'bad signature' }
}
