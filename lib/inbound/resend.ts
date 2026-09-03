import type { NextRequest } from 'next/server'

// Shared Resend Inbound helpers — a webhook secret guard and a full-message
// fetch (the `email.received` webhook is metadata-only; the body is fetched from
// the Received Emails API with a full-access key). Mirrors the mechanics the
// LeadGen inbound route established.

export interface InboundAttachment {
  filename: string | null
  contentType: string | null
  /** base64 — null when the payload gave us only a URL. */
  content: string | null
  /** Set when the attachment must be downloaded rather than read inline. */
  url?: string | null
}
export interface RawInboundEmail {
  from: string | null; subject: string | null; text: string | null; html: string | null
  /** Optional so the body-parsing callers (remittance, leadgen) and their own local
   *  RawInboundEmail shapes are unaffected; populated for senders whose payload IS an
   *  attachment, like the weekly Clopay DC report PDF. */
  attachments?: InboundAttachment[]
}

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
    attachments: extractAttachments(d),
  }
}

/** Attachments off a received-email payload. Resend has used more than one spelling for the
 *  content field across payload shapes, so accept the ones seen rather than guessing one;
 *  a URL-only attachment comes back with content null and is fetched separately. */
export function extractAttachments(d: Record<string, unknown>): InboundAttachment[] {
  const raw = d.attachments
  if (!Array.isArray(raw)) return []
  return raw.map(a => {
    const o = (a ?? {}) as Record<string, unknown>
    const content = o.content ?? o.content_base64 ?? o.data ?? null
    return {
      filename: (o.filename as string) ?? (o.name as string) ?? null,
      contentType: (o.content_type as string) ?? (o.contentType as string) ?? (o.type as string) ?? null,
      content: typeof content === 'string' && content ? content : null,
      url: (o.url as string) ?? (o.download_url as string) ?? null,
    } as InboundAttachment
  })
}

/** Attachments (base64) straight off Resend's received-email record. The webhook payload is
 *  metadata only, so anything that needs the bytes fetches them here. Proven by the Clopay
 *  STS DC-reply flow, which has been storing PDFs this way. */
export async function fetchReceivedAttachments(
  resendId: string,
): Promise<Array<{ filename: string; contentType: string; base64: string }>> {
  const key = process.env.RESEND_INBOUND_API_KEY || process.env.RESEND_API_KEY
  if (!key) return []
  try {
    const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(resendId)}`, {
      headers: { Authorization: `Bearer ${key}` },
    })
    if (!res.ok) return []
    const body = await res.json()
    const d = (body?.data ?? body) as Record<string, unknown>
    const atts = Array.isArray(d?.attachments) ? d.attachments : []
    return atts.map(a => {
      const o = (a ?? {}) as Record<string, unknown>
      return {
        filename: String(o.filename ?? o.name ?? 'attachment.pdf'),
        contentType: String(o.content_type ?? o.contentType ?? o.type ?? ''),
        base64: String(o.content ?? o.data ?? ''),
      }
    }).filter(a => a.base64)
  } catch { return [] }
}

/** Download an attachment Resend gave us by URL rather than inline. */
export async function fetchAttachmentBytes(url: string): Promise<Uint8Array | null> {
  const key = process.env.RESEND_INBOUND_API_KEY || process.env.RESEND_API_KEY
  try {
    const res = await fetch(url, key ? { headers: { Authorization: `Bearer ${key}` } } : undefined)
    if (!res.ok) return null
    return new Uint8Array(await res.arrayBuffer())
  } catch { return null }
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
