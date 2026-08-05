import type { NextRequest } from 'next/server'

// Shared Resend Inbound helpers — a webhook secret guard and a full-message
// fetch (the `email.received` webhook is metadata-only; the body is fetched from
// the Received Emails API with a full-access key). Mirrors the mechanics the
// LeadGen inbound route established.

export interface RawInboundEmail { from: string | null; subject: string | null; text: string | null; html: string | null }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** True if the request carries the expected secret (via ?token= or header), or
 *  if no secret is configured (dev). */
export function checkInboundSecret(req: NextRequest, envVar: string, header: string): boolean {
  const secret = process.env[envVar]
  if (!secret) return true
  const token = new URL(req.url).searchParams.get('token') || req.headers.get(header)
  return token === secret
}

function fromToString(fromField: unknown): string | null {
  if (typeof fromField === 'string') return fromField || null
  if (fromField && typeof fromField === 'object') {
    const o = fromField as Record<string, unknown>
    return String(o.address ?? o.email ?? o.from ?? '') || null
  }
  return null
}

export function extractEmail(d: Record<string, unknown>): RawInboundEmail {
  return {
    from: fromToString(d.from),
    subject: (d.subject as string) ?? null,
    text: (d.text as string) ?? (d.plain as string) ?? null,
    html: (d.html as string) ?? null,
  }
}

/** Fetch the full received email by id (retries while the body lags the webhook). */
export async function fetchReceivedEmail(id: string): Promise<{ email?: RawInboundEmail; error?: string }> {
  const key = process.env.RESEND_INBOUND_API_KEY || process.env.RESEND_API_KEY
  if (!key) return { error: 'no Resend key' }
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${key}` },
      })
      if (res.status === 401 || res.status === 403) return { error: `auth ${res.status}` }
      if (res.ok) {
        const body = await res.json()
        const d = (body?.data ?? body) as Record<string, unknown>
        return { email: extractEmail(d) }
      }
      // 404 (not ready) / 5xx → retry
    } catch { /* retry */ }
    await sleep(1000)
  }
  return { error: 'fetch failed' }
}
