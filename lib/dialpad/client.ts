// Dialpad API v2 client — SMS send + inbound webhook wiring for invoice reminders.
//
// Env:
//   DIALPAD_API_TOKEN     — API key (Bearer)
//   DIALPAD_FROM_NUMBER   — E.164 number we send from (e.g. +17605551234)
//   DIALPAD_USER_ID       — (optional) the sending user's id; resolved from the
//                           from-number if omitted
//   DIALPAD_WEBHOOK_SECRET — shared secret used to verify inbound webhooks
//   DIALPAD_API_BASE      — (optional) override, defaults to https://dialpad.com/api/v2
//
// Note: Dialpad's public reference is auth-gated, so payload shapes follow the
// documented v2 model. The admin "Test Dialpad" action surfaces raw responses so
// exact field names can be confirmed against a live account.

const BASE = process.env.DIALPAD_API_BASE || 'https://dialpad.com/api/v2'

export function isDialpadConfigured(): boolean {
  return !!(process.env.DIALPAD_API_TOKEN && process.env.DIALPAD_FROM_NUMBER)
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.DIALPAD_API_TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
}

/** Normalize a US phone to E.164 (+1XXXXXXXXXX). Returns null if not 10/11 digits. */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (raw.trim().startsWith('+') && digits.length >= 11) return `+${digits}`
  return null
}

async function dpFetch(path: string, init: RequestInit): Promise<{ ok: boolean; status: number; body: unknown }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    const res = await fetch(`${BASE}${path}`, { ...init, headers: authHeaders(), signal: controller.signal })
    const text = await res.text()
    let body: unknown = text
    try { body = text ? JSON.parse(text) : null } catch { /* keep raw text */ }
    return { ok: res.ok, status: res.status, body }
  } finally {
    clearTimeout(timeout)
  }
}

let cachedUserId: string | null = null

/** Resolve the sending user's id: explicit env, else the user owning the from-number. */
async function resolveUserId(): Promise<string | null> {
  if (process.env.DIALPAD_USER_ID) return process.env.DIALPAD_USER_ID
  if (cachedUserId) return cachedUserId
  const from = process.env.DIALPAD_FROM_NUMBER
  const res = await dpFetch(`/users?limit=100`, { method: 'GET' })
  if (!res.ok) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: any[] = (res.body as any)?.items ?? (res.body as any)?.users ?? []
  for (const u of items) {
    const nums: string[] = u.phone_numbers ?? u.numbers ?? []
    if (from && nums.some(n => toE164(n) === toE164(from))) {
      cachedUserId = String(u.id)
      return cachedUserId
    }
  }
  // Fall back to the first user if we couldn't match the number.
  if (items.length > 0) { cachedUserId = String(items[0].id); return cachedUserId }
  return null
}

export interface SmsSendResult {
  ok: boolean
  messageId: string | null
  status: number
  error?: string
  raw?: unknown
}

/** Send an SMS to one E.164 number. */
export async function sendSms(toE164Number: string, text: string): Promise<SmsSendResult> {
  if (!isDialpadConfigured()) return { ok: false, messageId: null, status: 0, error: 'Dialpad not configured' }
  const userId = await resolveUserId()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload: Record<string, any> = {
    to_numbers: [toE164Number],
    from_number: process.env.DIALPAD_FROM_NUMBER,
    text,
  }
  if (userId) payload.user_id = Number.isNaN(Number(userId)) ? userId : Number(userId)

  const res = await dpFetch(`/sms`, { method: 'POST', body: JSON.stringify(payload) })
  if (!res.ok) {
    return { ok: false, messageId: null, status: res.status, error: typeof res.body === 'string' ? res.body : JSON.stringify(res.body), raw: res.body }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const id = (res.body as any)?.id ?? (res.body as any)?.message_id ?? null
  return { ok: true, messageId: id != null ? String(id) : null, status: res.status, raw: res.body }
}

/** Lightweight connectivity/auth check. */
export async function testConnection(): Promise<{ ok: boolean; status: number; detail: string; userId: string | null }> {
  if (!isDialpadConfigured()) return { ok: false, status: 0, detail: 'DIALPAD_API_TOKEN / DIALPAD_FROM_NUMBER not set', userId: null }
  const res = await dpFetch(`/users?limit=1`, { method: 'GET' })
  const userId = res.ok ? await resolveUserId() : null
  return {
    ok: res.ok,
    status: res.status,
    detail: res.ok ? 'Token accepted' : (typeof res.body === 'string' ? res.body : JSON.stringify(res.body)),
    userId,
  }
}

/**
 * Register the inbound-SMS webhook + subscription so STOP replies reach us.
 * Creates a webhook pointing at `hookUrl` (secured by DIALPAD_WEBHOOK_SECRET),
 * then an inbound SMS event subscription bound to it. Idempotency is best-effort;
 * safe to re-run (surfaces the raw responses so duplicates can be pruned).
 */
export async function registerInboundWebhook(hookUrl: string): Promise<{ ok: boolean; webhookId: string | null; subscriptionId: string | null; detail: unknown }> {
  const secret = process.env.DIALPAD_WEBHOOK_SECRET
  const wh = await dpFetch(`/webhooks`, { method: 'POST', body: JSON.stringify({ hook_url: hookUrl, secret }) })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const webhookId = (wh.body as any)?.id != null ? String((wh.body as any).id) : null
  if (!wh.ok || !webhookId) return { ok: false, webhookId, subscriptionId: null, detail: wh.body }

  const sub = await dpFetch(`/subscriptions/sms`, {
    method: 'POST',
    body: JSON.stringify({ webhook_id: Number.isNaN(Number(webhookId)) ? webhookId : Number(webhookId), direction: 'inbound', enabled: true }),
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const subscriptionId = (sub.body as any)?.id != null ? String((sub.body as any).id) : null
  return { ok: sub.ok, webhookId, subscriptionId, detail: { webhook: wh.body, subscription: sub.body } }
}
