import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { parseStsOrders } from './parse'
import { uploadAttachmentBytes } from './attachments'
import type { RawInboundEmail } from '@/lib/inbound/resend'

// Clopay STS ingest: two inbound flows on the STS forwarded address —
//   • ingestStsEmail  — a forwarded Clopay order email → upsert STS orders
//   • ingestDcReply   — the DC's acknowledgement reply → save its text + PDF
// Both are idempotent on the Resend email id and log to clopay_sts_inbound_events.

const VENDOR = 'clopay_sts'

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

const stripHtml = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim()

async function alreadySeen(supabase: SupabaseClient, resendId: string | null): Promise<boolean> {
  if (!resendId) return false
  const { data } = await supabase.from('clopay_sts_inbound_events').select('id').eq('resend_email_id', resendId).maybeSingle()
  return !!data
}

async function logInbound(supabase: SupabaseClient, resendId: string | null, email: RawInboundEmail, kind: string, outcome: string, detail?: string) {
  try {
    await supabase.from('clopay_sts_inbound_events').insert({
      resend_email_id: resendId, from_addr: email.from, subject: email.subject, kind, outcome, detail: detail ?? null,
    })
  } catch { /* non-critical audit */ }
}

export interface StsIngestResult { ok: boolean; outcome: string; orders?: number }

/** A forwarded Clopay order email → upsert the STS order lines. */
export async function ingestStsEmail(email: RawInboundEmail, resendId: string | null): Promise<StsIngestResult> {
  const supabase = db()
  if (await alreadySeen(supabase, resendId)) return { ok: true, outcome: 'duplicate', orders: 0 }

  const lines = parseStsOrders(email.text, email.html)
  let inserted = 0
  for (const l of lines) {
    const nowIso = new Date().toISOString()
    const { data: prior } = await supabase.from('vendor_orders').select('id').eq('vendor', VENDOR).eq('external_id', l.external_id).maybeSingle()
    if (prior) {
      // Re-forward of an order we already have — refresh PO/last-seen, keep status.
      await supabase.from('vendor_orders').update({ customer_po: l.customer_po, last_seen_at: nowIso, updated_at: nowIso }).eq('id', prior.id)
      continue
    }
    const { data: ins } = await supabase.from('vendor_orders').insert({
      vendor: VENDOR, external_id: l.external_id, customer_po: l.customer_po,
      status: 'Received', order_type: 'STS',
      raw: { source: 'clopay_sts_email', raw_line: l.raw_line, resend_email_id: resendId, subject: email.subject },
      first_seen_at: nowIso, last_seen_at: nowIso,
    }).select('id').single()
    if (ins) {
      inserted++
      await supabase.from('vendor_order_events').insert({ order_id: ins.id, event_type: 'seen', to_value: 'Received' })
    }
  }
  const outcome = lines.length === 0 ? 'no_sts' : 'ingested'
  await logInbound(supabase, resendId, email, 'orders', outcome, `${lines.length} STS line(s), ${inserted} new`)
  return { ok: true, outcome, orders: inserted }
}

// Pull attachments (base64) from the Resend received-email record. Resend's shape
// isn't guaranteed to include bytes; if it doesn't, manual upload covers it.
async function fetchAttachments(resendId: string): Promise<Array<{ filename: string; contentType: string; base64: string }>> {
  const key = process.env.RESEND_INBOUND_API_KEY || process.env.RESEND_API_KEY
  if (!key) return []
  try {
    const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(resendId)}`, { headers: { Authorization: `Bearer ${key}` } })
    if (!res.ok) return []
    const body = await res.json()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = (body?.data ?? body) as any
    const atts = Array.isArray(d?.attachments) ? d.attachments : []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return atts.map((a: any) => ({
      filename: String(a.filename ?? a.name ?? 'attachment.pdf'),
      contentType: String(a.content_type ?? a.contentType ?? a.type ?? ''),
      base64: String(a.content ?? a.data ?? ''),
    })).filter((a: { base64: string }) => a.base64)
  } catch { return [] }
}

/** The DC's acknowledgement reply → match to the order, save text, attach PDF(s). */
export async function ingestDcReply(email: RawInboundEmail, resendId: string | null): Promise<StsIngestResult> {
  const supabase = db()
  if (await alreadySeen(supabase, resendId)) return { ok: true, outcome: 'duplicate' }

  const hay = `${email.subject ?? ''}\n${email.text ?? (email.html ? stripHtml(email.html) : '')}`
  const orderNum = hay.match(/\b(\d{6,9})\b/)?.[1] ?? null
  let orderId: string | null = null
  if (orderNum) {
    const { data: o } = await supabase.from('vendor_orders').select('id').eq('vendor', VENDOR).eq('external_id', orderNum).maybeSingle()
    orderId = (o?.id as string) ?? null
  }
  if (!orderId) {
    await logInbound(supabase, resendId, email, 'dc_reply', 'no_match', `no STS order for ${orderNum ?? '—'}`)
    return { ok: true, outcome: 'no_match' }
  }

  // Save the raw reply text (DC sometimes adds extra notes) + stamp received.
  const nowIso = new Date().toISOString()
  const rawText = email.text || (email.html ? stripHtml(email.html) : '')
  const { data: cur } = await supabase.from('vendor_orders').select('raw').eq('id', orderId).maybeSingle()
  const raw = { ...((cur?.raw as Record<string, unknown>) ?? {}), dc_reply_text: rawText, dc_reply_subject: email.subject }
  await supabase.from('vendor_orders').update({ raw, details_received_at: nowIso, updated_at: nowIso }).eq('id', orderId)
  await supabase.from('vendor_order_events').insert({ order_id: orderId, event_type: 'dc_reply', detail: { subject: email.subject } })

  // Attach any PDF(s) from the reply.
  let attached = 0
  if (resendId) {
    for (const a of await fetchAttachments(resendId)) {
      if (!/pdf/i.test(a.contentType) && !/\.pdf$/i.test(a.filename)) continue
      try {
        const bytes = new Uint8Array(Buffer.from(a.base64, 'base64'))
        const up = await uploadAttachmentBytes(orderId, a.filename, a.contentType || 'application/pdf', bytes, 'dc_reply', null)
        if (up.ok) attached++
      } catch { /* skip a bad attachment */ }
    }
  }
  await logInbound(supabase, resendId, email, 'dc_reply', 'ingested', `order ${orderNum}, ${attached} pdf(s)`)
  return { ok: true, outcome: 'ingested' }
}
