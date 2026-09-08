import { createPrivateKey, createSign, createVerify, X509Certificate } from 'crypto'
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

interface ServiceAccount { client_email: string; private_key: string; raw_private_key: string; stored_as: 'raw JSON' | 'base64' }

const PEM_RE = /-----BEGIN ([A-Z ]*PRIVATE KEY)-----([\s\S]*?)-----END \1-----/

// The first bytes of a DER key say which encoding it is. PKCS#8 wraps the key in an
// AlgorithmIdentifier carrying the RSA OID; PKCS#1 is the bare RSAPrivateKey. OpenSSL
// decodes by the PEM label, so a PKCS#1 key mislabelled "PRIVATE KEY" — which is what
// some re-wrapping tools emit — fails with exactly the DECODER error we are chasing.
const RSA_OID = Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01])
function derLabel(der: Buffer): string | null {
  if (der.length < 32 || der[0] !== 0x30) return null
  if (der.subarray(0, 40).includes(RSA_OID)) return 'PRIVATE KEY'          // PKCS#8
  // PKCS#1: SEQUENCE, version 0, then the modulus INTEGER straight away.
  if (der[4] === 0x02 && der[5] === 0x01 && der[6] === 0x00 && der[7] === 0x02) return 'RSA PRIVATE KEY'
  return null
}

const derOf = (pem: string) => Buffer.from(pem.replace(/-----[A-Z -]+-----/g, '').replace(/\s/g, ''), 'base64')

// Everything else checks the envelope; this checks the contents, and OpenSSL is the only
// authority worth asking. A wrapper that parses around material that does not means the
// bytes were altered in transit rather than lost — which points at the store, not the file.
function keyMaterialIntact(der: Buffer): boolean {
  try { createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }); return true } catch { return false }
}

/** A service-account private key rarely survives an environment variable intact, and
 *  OpenSSL reports every one of the ways it breaks as the same opaque
 *  "error:1E08010C:DECODER routines::unsupported". The ways it arrives broken:
 *    • its newlines come through as the two characters \ and n, because the value was
 *      escaped a second time between the key file and the env store;
 *    • the whole value is wrapped in quotes the store did not strip;
 *    • its line breaks were collapsed to spaces, or lost altogether, by a UI that
 *      treated the value as a single line of text;
 *    • its base64 was rewritten URL-safe, so + and / arrive as - and _;
 *    • the bytes are a PKCS#1 key under a PKCS#8 label.
 *  None of that is the operator's doing and all of it is repairable, so rather than
 *  patching the symptoms we rebuild the PEM from the bytes: take the body between the
 *  markers, restore URL-safe substitutions, discard what is still not base64, and
 *  re-wrap at 64 characters under whichever label the decoded DER actually calls for. */
export function normalizePrivateKey(raw: string): string {
  let key = (raw ?? '').trim()
  if (key.length > 1 && ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'")))) key = key.slice(1, -1)
  // Undo double-escaping first: a stray backslash would survive the body filter below as
  // the letter n, quietly corrupting the base64 instead of being dropped.
  key = key.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim()

  const m = PEM_RE.exec(key)
  if (!m) return key.endsWith('\n') ? key : `${key}\n`
  const body = m[2].replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/=]/g, '')
  const label = derLabel(Buffer.from(body, 'base64')) ?? m[1]
  const lines = body.match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

/** What is wrong with a key, in terms an operator can act on, without ever printing it or
 *  any of its secret bytes. Reads the RAW value, not the repaired one: the interesting
 *  evidence is what the repair had to throw away. */
export function describePrivateKey(raw: string): string {
  const m = PEM_RE.exec(raw ?? '')
  if (!m) return 'no matching BEGIN/END PRIVATE KEY markers — the value is not a PEM key at all'
  const inner = m[2].replace(/\\[rn]/g, '').replace(/\s/g, '')
  const dropped = inner.replace(/[A-Za-z0-9+/=]/g, '')
  const body = inner.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/=]/g, '')
  const parts = [`label ${m[1]}`, `${body.length} base64 characters`]
  if (dropped.length) parts.push(`${dropped.length} characters outside the base64 alphabet`)

  const der = Buffer.from(body, 'base64')
  parts.push(`${der.length} decoded bytes`)
  if (der.length < 16 || der[0] !== 0x30) { parts.push('which are not an ASN.1 SEQUENCE, so the base64 is not a key'); return parts.join(', ') }
  // A key's outer SEQUENCE declares its own length; if that disagrees with what we have,
  // bytes were lost or added and we can say which.
  if (der[1] === 0x82) {
    const declared = der.readUInt16BE(2) + 4
    if (declared !== der.length) parts.push(`an ASN.1 length declaring ${declared} bytes, so ${declared > der.length ? `${declared - der.length} are missing` : `${der.length - declared} are extra`}`)
  }
  const label = derLabel(der)
  if (!label) parts.push('and a structure matching neither PKCS#8 nor PKCS#1, so the bytes are corrupt')
  else if (label !== m[1]) parts.push(`bytes that are actually ${label}`)
  else if (label === 'PRIVATE KEY' && !keyMaterialIntact(der)) parts.push('an intact PKCS#8 wrapper around key material that is NOT intact, so the bytes were altered rather than lost — something is rewriting the value where it is stored')
  return parts.join(', ')
}

function serviceAccount(): ServiceAccount {
  const raw = process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_JSON ?? ''
  if (!raw.trim()) throw new Error('GOOGLE_CHAT_SERVICE_ACCOUNT_JSON is not set')
  const stored_as = raw.trim().startsWith('{') ? 'raw JSON' as const : 'base64' as const
  const json = stored_as === 'raw JSON' ? raw : Buffer.from(raw, 'base64').toString('utf8')
  let sa: ServiceAccount
  try { sa = JSON.parse(json) as ServiceAccount }
  catch { throw new Error('GOOGLE_CHAT_SERVICE_ACCOUNT_JSON is not valid JSON — paste the whole key file, or its base64') }
  if (!sa.client_email || !sa.private_key) throw new Error('GOOGLE_CHAT_SERVICE_ACCOUNT_JSON is missing client_email or private_key')
  const private_key = normalizePrivateKey(sa.private_key)
  if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(private_key)) {
    throw new Error('The private_key in GOOGLE_CHAT_SERVICE_ACCOUNT_JSON does not begin with a PEM header — re-copy the key file from Google Cloud')
  }
  return { client_email: sa.client_email, private_key, raw_private_key: sa.private_key, stored_as }
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
  catch (pemError) {
    // The PEM wrapper is ours, rebuilt from the bytes, so it is almost certainly not the
    // problem — but signing straight from the DER costs nothing and rules it out entirely.
    try { signature = signer.sign(createPrivateKey({ key: derOf(sa.private_key), format: 'der', type: 'pkcs8' })) }
    catch {
      // OpenSSL's DECODER error names neither the key nor the reason. Say both, and say
      // how the value is stored — the two facts that decide what to do next.
      throw new Error(`Could not sign with the service-account private key (${pemError instanceof Error ? pemError.message : pemError}). It is stored as ${sa.stored_as} in GOOGLE_CHAT_SERVICE_ACCOUNT_JSON, and has ${describePrivateKey(sa.raw_private_key)}.`)
    }
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

/** Does a key file sign, independent of what is in the environment? This is the one
 *  experiment that separates the two possible faults: if the file the operator downloaded
 *  signs here but the deployed value does not, the env store is altering it; if neither
 *  signs, the key file itself is bad and no amount of repair will help. The pasted text is
 *  used and dropped — never stored, never logged, never echoed back. */
export function checkKeyFile(pasted: string): { ok: boolean; message: string } {
  const text = (pasted ?? '').trim()
  if (!text) return { ok: false, message: 'Paste the contents of the key file first.' }

  let key = ''
  let account = ''
  if (text.startsWith('{')) {
    try {
      const j = JSON.parse(text) as { private_key?: string; client_email?: string }
      key = j.private_key ?? ''
      account = j.client_email ?? ''
      if (!key) return { ok: false, message: 'That JSON has no private_key field — paste the whole service-account key file.' }
    } catch { return { ok: false, message: 'That is not valid JSON. Paste the whole key file, exactly as downloaded.' } }
  } else if (text.includes('PRIVATE KEY')) {
    key = text
  } else {
    return { ok: false, message: 'That looks like neither a key file nor a PEM key.' }
  }

  const pem = normalizePrivateKey(key)
  try {
    const signer = createSign('RSA-SHA256'); signer.update('castle'); signer.sign(pem)
  } catch (e) {
    return { ok: false, message: `This key file does NOT sign, so the file itself is the problem, not the environment variable — download a fresh key from Google Cloud. (${e instanceof Error ? e.message : e}; the key has ${describePrivateKey(key)}.)` }
  }

  const deployed = process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_JSON ?? ''
  const same = deployed.includes(key.slice(-40).trim()) || deployed.includes(key.replace(/\n/g, '\\n').slice(-40))
  return {
    ok: true,
    message: `This key file signs correctly${account ? ` (${account})` : ''}. `
      + (same
        ? 'It also matches what is deployed, so the environment variable is intact and the fault is elsewhere.'
        : 'It does NOT match the value currently deployed — so the environment variable is either a different key or is being altered in storage. Re-paste this file into GOOGLE_CHAT_SERVICE_ACCOUNT_JSON, base64-encoded, and redeploy.'),
  }
}
