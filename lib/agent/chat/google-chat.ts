import { createSign, createVerify, X509Certificate } from 'crypto'
import { appUrl } from '@/lib/config/domains'

// Google Chat, app-authenticated (PRD §11 "Technical implementation"). Raw REST + a
// service-account JWT, no googleapis dependency.
//
//   Env: GOOGLE_CHAT_SERVICE_ACCOUNT_JSON — the service account key JSON (raw or base64)
//        GOOGLE_CHAT_PROJECT_NUMBER      — optional; one of the audiences we accept
//
//   Posting uses scope chat.bot. Events arrive at /api/cassie/chat/events with a
//   Google-signed bearer token; verifyEventToken checks signature, issuer and audience.

const SCOPE = 'https://www.googleapis.com/auth/chat.bot'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API = 'https://chat.googleapis.com/v1'
// Who signs the events Google sends us. A classic Chat app is signed by Chat itself; a
// Chat app built as a Workspace add-on ("Build this Chat app as a Workspace add-on" in the
// Chat API config) is signed by that project's add-ons service agent instead. Both are
// Google-controlled identities and both are verified against Google's published cert for
// that exact issuer, so accepting both costs nothing and saves picking a config mode.
const CHAT_ISSUER = 'chat@system.gserviceaccount.com'
const addonsIssuer = (projectNumber: string) => `service-${projectNumber}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`
const certsUrlFor = (issuer: string) => `https://www.googleapis.com/service_accounts/v1/metadata/x509/${encodeURIComponent(issuer)}`

export function allowedIssuers(): string[] {
  const n = (process.env.GOOGLE_CHAT_PROJECT_NUMBER ?? '').trim()
  return n ? [CHAT_ISSUER, addonsIssuer(n)] : [CHAT_ISSUER]
}

/** Posting needs only the service account key; the project number is one of two
 *  audiences we accept on inbound events, so it is not required to be configured. */
export function isChatConfigured(): boolean {
  return !!process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_JSON
}

/** Where Google Chat posts events. Also a valid `aud` value — see allowedAudiences(). */
export function chatEventsUrl(): string { return `${appUrl()}/api/cassie/chat/events` }

interface ServiceAccount { client_email: string; private_key: string }

/** A service-account private key rarely survives an environment variable intact. The two
 *  ways it arrives broken, both of which OpenSSL reports only as the opaque
 *  "error:1E08010C:DECODER routines::unsupported":
 *    • its newlines come through as the two characters \ and n, because the value was
 *      escaped a second time between the key file and the env store;
 *    • the whole value is wrapped in quotes the store did not strip.
 *  Neither is the operator's doing and both are trivially repairable, so repair them
 *  rather than making someone decode an OpenSSL error code. */
export function normalizePrivateKey(raw: string): string {
  let key = (raw ?? '').trim()
  if (key.length > 1 && ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'")))) key = key.slice(1, -1)
  key = key.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim()
  return key.endsWith('\n') ? key : `${key}\n`
}

function serviceAccount(): ServiceAccount {
  const raw = process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_JSON ?? ''
  if (!raw.trim()) throw new Error('GOOGLE_CHAT_SERVICE_ACCOUNT_JSON is not set')
  const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')
  let sa: ServiceAccount
  try { sa = JSON.parse(json) as ServiceAccount }
  catch { throw new Error('GOOGLE_CHAT_SERVICE_ACCOUNT_JSON is not valid JSON — paste the whole key file, or its base64') }
  if (!sa.client_email || !sa.private_key) throw new Error('GOOGLE_CHAT_SERVICE_ACCOUNT_JSON is missing client_email or private_key')
  const private_key = normalizePrivateKey(sa.private_key)
  if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(private_key)) {
    throw new Error('The private_key in GOOGLE_CHAT_SERVICE_ACCOUNT_JSON does not begin with a PEM header — re-copy the key file from Google Cloud')
  }
  return { client_email: sa.client_email, private_key }
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
  let signature: Buffer
  try { signature = signer.sign(sa.private_key) }
  catch (e) {
    // OpenSSL's DECODER error names neither the key nor the reason. Say both.
    throw new Error(`Could not sign with the service-account private key (${e instanceof Error ? e.message : e}). The key in GOOGLE_CHAT_SERVICE_ACCOUNT_JSON is not readable as PEM — re-paste the key file, base64-encoded so it survives the env store.`)
  }
  const jwt = `${header}.${claims}.${b64url(signature)}`
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

const certCache = new Map<string, { at: number; certs: Record<string, string> }>()
async function issuerCerts(issuer: string): Promise<Record<string, string>> {
  const hit = certCache.get(issuer)
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.certs
  const res = await fetch(certsUrlFor(issuer))
  if (!res.ok) throw new Error(`Could not fetch signing certs for ${issuer} (${res.status})`)
  const certs = await res.json() as Record<string, string>
  certCache.set(issuer, { at: Date.now(), certs })
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

/** The audiences we accept on an inbound event.
 *
 *  Google Chat's app configuration lets you pick what it puts in the token's `aud`: the
 *  Cloud project number, or the app's own endpoint URL. Which one is offered — and where
 *  the control lives — has moved around between console versions, and getting it wrong
 *  produces silent 401s that look like nothing arriving at all. Both values are equally
 *  strong proof (the token is signed by Google either way), so accept both and let the
 *  setting be whatever it is. */
export function allowedAudiences(): string[] {
  return [process.env.GOOGLE_CHAT_PROJECT_NUMBER, chatEventsUrl()].filter((a): a is string => !!a && a.trim() !== '')
}

/** Google signs every event it sends us. Reject anything else outright. */
export async function verifyEventToken(authorization: string | null, audiences: string[] = allowedAudiences(), issuers: string[] = allowedIssuers()): Promise<{ ok: true } | { ok: false; reason: string }> {
  const token = (authorization ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!token) return { ok: false, reason: 'no bearer token' }
  const d = decodeJwt(token)
  if (!d) return { ok: false, reason: 'malformed token' }
  if (d.header.alg !== 'RS256') return { ok: false, reason: `unexpected alg ${d.header.alg}` }
  if (!d.payload.iss || !issuers.includes(d.payload.iss)) return { ok: false, reason: `issuer ${d.payload.iss ?? 'missing'} is not one of ${issuers.join(', ')}` }
  if (!d.payload.aud || !audiences.includes(d.payload.aud)) return { ok: false, reason: `audience ${d.payload.aud ?? 'missing'} is not one of ${audiences.join(', ')}` }
  if (!d.payload.exp || d.payload.exp * 1000 < Date.now()) return { ok: false, reason: 'expired' }
  const certs = await issuerCerts(d.payload.iss)
  const pem = d.header.kid ? certs[d.header.kid] : undefined
  if (!pem) return { ok: false, reason: 'unknown signing key' }
  const [h, p, sig] = token.split('.')
  const v = createVerify('RSA-SHA256'); v.update(`${h}.${p}`)
  const ok = v.verify(new X509Certificate(pem).publicKey, Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))
  return ok ? { ok: true } : { ok: false, reason: 'bad signature' }
}

// ── Connection test ─────────────────────────────────────────────────────────

/** Post a throwaway message to the space and report what happened, in plain English.
 *  Exercises exactly the outbound path an ask uses: service-account JWT → token → post.
 *  Used by the "Test connection" button so a misconfiguration names itself in one click
 *  instead of being inferred from a card that never appeared. */
export async function testChatConnection(space: string): Promise<{ ok: boolean; message: string }> {
  if (!space.trim()) return { ok: false, message: 'No space is set. Paste the space resource name (spaces/AAAA…) above and save first.' }
  if (!/^spaces\//.test(space.trim())) return { ok: false, message: `"${space}" does not look like a space resource name. It should start with "spaces/".` }
  if (!isChatConfigured()) return { ok: false, message: 'GOOGLE_CHAT_SERVICE_ACCOUNT_JSON is not set in Vercel (or the deploy predates it).' }
  try {
    await chatAccessToken()
  } catch (e) {
    return { ok: false, message: `Could not authenticate as the service account: ${e instanceof Error ? e.message : String(e)}` }
  }
  try {
    const posted = await postText(space.trim(), `cassie-test-${Date.now()}`, 'Connection test from Castle Admin — Cassie can post here. You can ignore this message.')
    return { ok: true, message: `Posted to the space (${posted.name}). Check Google Chat.` }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const hint = /403/.test(msg) ? ' — a 403 usually means the Cassie app has not been added to that space, or the service account is in a different Cloud project from the Chat app.'
      : /404/.test(msg) ? ' — a 404 usually means the space resource name is wrong.'
      : ''
    return { ok: false, message: `${msg}${hint}` }
  }
}
