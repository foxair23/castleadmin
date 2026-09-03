import { NextRequest, NextResponse } from 'next/server'
import { parseLead, emailToText, type RawInboundEmail } from '@/lib/leadgen/parse'
import { ingestLead, logInboundEvent } from '@/lib/leadgen/engine'
import { aiExtractLead, isAiExtractConfigured } from '@/lib/leadgen/ai-extract'
import { ingestRemittance } from '@/lib/remittance/engine'
import { ingestStsEmail, ingestDcReply } from '@/lib/clopay-sts/engine'
import { ingestDcReportEmail } from '@/lib/clopay-dc/from-email'

export const maxDuration = 60

// Does the webhook metadata list a PDF attachment? (The DC's acknowledgement reply
// carries one; a forwarded order email doesn't.)
function hasPdfAttachment(data: Record<string, unknown>): boolean {
  const atts = (data.attachments as Array<Record<string, unknown>> | undefined) ?? []
  return atts.some(a =>
    /pdf/i.test(String(a.content_type ?? a.contentType ?? a.type ?? '')) ||
    /\.pdf$/i.test(String(a.filename ?? a.name ?? '')))
}

// Inbound provider-lead email (via Resend Inbound). Forwarded HD "new lead"
// emails land here; we parse and ingest them. Guarded by a shared secret passed
// as ?token= (or x-leadgen-secret header) so only our Resend webhook can post.
//
// IMPORTANT: Resend's `email.received` webhook is METADATA ONLY (from/to/subject
// + attachment names) — the body is not in the payload. We take the received
// email's id and fetch the full message (text/html) from the Received Emails API
// before parsing. If a payload already carries the body (other providers / tests)
// we use it directly.
//
// Always returns 200 on parse/ingest issues so the sender doesn't retry-storm;
// a bad/missing token is the one hard failure.

function fromToString(fromField: unknown): string | null {
  if (typeof fromField === 'string') return fromField || null
  if (fromField && typeof fromField === 'object') {
    const o = fromField as Record<string, unknown>
    return String(o.address ?? o.email ?? o.from ?? '') || null
  }
  return null
}

function extractEmail(d: Record<string, unknown>): RawInboundEmail {
  return {
    from: fromToString(d.from),
    subject: (d.subject as string) ?? null,
    text: (d.text as string) ?? (d.plain as string) ?? null,
    html: (d.html as string) ?? null,
  }
}

// Recipient(s) as a flat string — Resend delivers `to` as a string, an array of
// strings, or an array of {address}. Used to route by local-part (leads@ vs
// remittances@) since one inbound webhook serves the whole receiving domain.
function recipientToString(toField: unknown): string {
  if (typeof toField === 'string') return toField
  if (Array.isArray(toField)) {
    return toField.map(t => (typeof t === 'string' ? t : String((t as Record<string, unknown>)?.address ?? (t as Record<string, unknown>)?.email ?? ''))).join(', ')
  }
  if (toField && typeof toField === 'object') {
    const o = toField as Record<string, unknown>
    return String(o.address ?? o.email ?? '')
  }
  return ''
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Pull the full received email (with body) from Resend by id. Returns the email
// or a human-readable error for the inbound log. The body can lag the webhook by
// a moment, so retry a few times on 404/not-ready and transient 5xx.
async function fetchReceivedEmail(id: string): Promise<{ email?: RawInboundEmail; error?: string }> {
  // Reading a received email needs a FULL-ACCESS key; the send key is often
  // restricted to sending only. Use a dedicated inbound key if provided, else
  // fall back to the main key.
  const key = process.env.RESEND_INBOUND_API_KEY || process.env.RESEND_API_KEY
  if (!key) return { error: 'RESEND_INBOUND_API_KEY / RESEND_API_KEY not set' }
  const url = `https://api.resend.com/emails/receiving/${encodeURIComponent(id)}`
  let lastError = 'unknown'
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(1000)
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } })
      if (res.ok) {
        const d = (await res.json()) as Record<string, unknown>
        return { email: extractEmail((d.data && typeof d.data === 'object' ? d.data : d) as Record<string, unknown>) }
      }
      const body = await res.text().catch(() => '')
      lastError = `HTTP ${res.status}: ${body.slice(0, 300)}`
      // Auth/permission errors won't fix themselves — stop retrying.
      if (res.status === 401 || res.status === 403) break
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
  }
  return { error: lastError }
}

export async function POST(req: NextRequest) {
  const secret = process.env.LEADGEN_INBOUND_SECRET
  if (secret) {
    const token = req.nextUrl.searchParams.get('token') ?? req.headers.get('x-leadgen-secret')
    if (token !== secret) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ ok: true, ignored: 'unparseable body' }) }

  // Ignore non-inbound webhook events (email.sent/bounced/etc.) if this endpoint
  // ever receives them.
  const type = body.type as string | undefined
  if (type && type !== 'email.received' && type !== 'inbound.email') {
    return NextResponse.json({ ok: true, ignored: `event ${type}` })
  }

  const data = (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, unknown>
  const emailId = (data.email_id as string) ?? (data.id as string) ?? null
  const metaFrom = fromToString(data.from)
  const metaSubject = (data.subject as string) ?? null

  // The weekly Clopay DC report ("Fully Received and Reserved") — a PDF listing what is
  // physically sitting at the DC, the only source of an order's reserved date.
  //
  // Routed HERE, before the body is fetched, because this email IS its attachment: there is
  // little or no body to fetch, and the fetch below returns early when it comes back empty —
  // which would kill the report before any recipient check ran. Everything this branch needs
  // is in the webhook metadata (the recipient and the email id); it pulls the PDF itself.
  //
  // It must also stay ahead of the vendor-sender net further down: the DC sends from
  // clopay.com and a Gmail auto-forward preserves that From, so the net would otherwise
  // claim it and file the report as an unmatched remittance. `clopay@` cannot collide with
  // `clopay-sts@` — the hyphen breaks the match.
  const earlyRecipient = recipientToString(data.to)
  if (/\bclopay@/i.test(earlyRecipient)) {
    try {
      const result = await ingestDcReportEmail(emailId, metaSubject)
      await logInboundEvent({
        from_addr: metaFrom, subject: metaSubject, resend_email_id: emailId,
        outcome: result.ok ? 'clopay_dc' : 'clopay_dc_failed',
        detail: result.ok ? `${result.status}: ${result.rows ?? 0} rows, ${result.newPos ?? 0} new POs` : (result.error ?? 'unknown'),
      })
      return NextResponse.json({ route: 'clopay_dc', ...result })
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      await logInboundEvent({ from_addr: metaFrom, subject: metaSubject, resend_email_id: emailId, outcome: 'clopay_dc_failed', detail })
      return NextResponse.json({ ok: true, route: 'clopay_dc', error: detail })
    }
  }

  // Prefer an inline body; otherwise fetch the full email by id.
  let email: RawInboundEmail
  if (data.text || data.html) {
    email = extractEmail(data)
  } else {
    if (!emailId) {
      await logInboundEvent({ from_addr: metaFrom, subject: metaSubject, resend_email_id: null, outcome: 'error', detail: 'no body and no email id' })
      return NextResponse.json({ ok: true, ignored: 'no body and no email id' })
    }
    const { email: full, error } = await fetchReceivedEmail(emailId)
    if (!full) {
      await logInboundEvent({ from_addr: metaFrom, subject: metaSubject, resend_email_id: emailId, outcome: 'fetch_failed', detail: `fetch body: ${error ?? 'unknown'}` })
      return NextResponse.json({ ok: true, ignored: 'could not fetch email body', detail: error })
    }
    email = full
  }

  // One inbound webhook serves every address on this receiving domain, so route
  // by recipient.
  const recipient = recipientToString(data.to)

  // Clopay STS orders (and the DC's acknowledgement replies) come to a dedicated
  // address — route by that recipient FIRST, before the vendor-sender remittance
  // net below (Clopay is also a remittance sender). A PDF attachment ⇒ the DC's
  // reply (attach it); otherwise a forwarded order email (parse STS lines).
  if (/clopay-sts@|istore@/i.test(recipient)) {
    try {
      const isDcReply = hasPdfAttachment(data)
      const result = isDcReply ? await ingestDcReply(email, emailId) : await ingestStsEmail(email, emailId)
      return NextResponse.json({ route: isDcReply ? 'clopay_sts_dc_reply' : 'clopay_sts', ...result })
    } catch (e) {
      return NextResponse.json({ ok: true, route: 'clopay_sts', error: e instanceof Error ? e.message : String(e) })
    }
  }

  // One inbound webhook serves every address on this receiving domain, so route
  // by recipient: vendor payment remittances (remittances@…) — or anything from a
  // known vendor sender, as a safety net — go to the remittance pipeline; every-
  // thing else is treated as a lead.
  const fromVendor = /(clopay|overheaddoor)\.com/i.test(email.from ?? metaFrom ?? '')
  if (/remittances@/i.test(recipient) || fromVendor) {
    try {
      const result = await ingestRemittance(email, emailId)
      return NextResponse.json({ route: 'remittance', ...result })
    } catch (e) {
      return NextResponse.json({ ok: true, route: 'remittance', error: e instanceof Error ? e.message : String(e) })
    }
  }

  // Deterministic parser first (known providers — free + instant); fall back to
  // AI extraction for unknown providers / unrecognized layouts when configured.
  let parsed = parseLead(email)
  let via = 'regex'
  if (!parsed && isAiExtractConfigured()) {
    const text = emailToText(email)
    if (text.trim()) {
      const aiParsed = await aiExtractLead(text)
      if (aiParsed) { parsed = { parsed: aiParsed, text }; via = 'ai' }
    }
  }
  if (!parsed) {
    await logInboundEvent({ from_addr: email.from ?? metaFrom, subject: email.subject ?? metaSubject, resend_email_id: emailId, outcome: 'not_lead', detail: 'no recognized provider / no contact info' })
    return NextResponse.json({ ok: true, ignored: 'not a recognized lead' })
  }

  try {
    const result = await ingestLead(parsed.parsed, parsed.text)
    await logInboundEvent({
      from_addr: email.from ?? metaFrom, subject: email.subject ?? metaSubject, resend_email_id: emailId,
      outcome: result.status, lead_id: result.leadId,
      detail: [via === 'ai' ? 'via AI' : null, result.sent.length ? `sent: ${result.sent.join(', ')}` : null].filter(Boolean).join(' · ') || null,
    })
    return NextResponse.json({ ok: true, via, ...result })
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    await logInboundEvent({ from_addr: email.from ?? metaFrom, subject: email.subject ?? metaSubject, resend_email_id: emailId, outcome: 'error', detail })
    return NextResponse.json({ ok: true, error: detail })
  }
}
