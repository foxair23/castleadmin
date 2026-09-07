import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { sendEmail } from '@/lib/notifications/resend'
import { officeEmail, clopayStsInboundAddress } from '@/lib/config/domains'
import { CLOPAY_STS_STAGES, STS_REQUESTED, STS_CLOSED, advancedStatus } from './stages'

// Clopay STS "request details from the DC" email. For each STS order we ask the
// San Diego Distribution Center for the delivery details; the DC replies with a
// Sales Order Acknowledgement PDF (ingested via ingestDcReply). Mirrors the
// schedule-nudge toggle+cutoff+cron pattern.
//   • sendDcRequest(orderId)        — one email (cron + manual button share it)
//   • runClopayStsAutoRequest()     — cron sweep of new, not-yet-requested orders
//   • getStsSettings / setStsSettings — the settings singleton
// Every DC email cc's the office inbox (lib/config/domains) and, on success, stamps
// details_requested_at and advances the status to 'Requested from DC'.

const VENDOR = 'clopay_sts'
const CC_ADDRESS = officeEmail()
// The DC replies here so its PDF comes back into the STS inbound pipeline.
const STS_INBOUND_ADDRESS = clopayStsInboundAddress()
const SEND_CAP = 25
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export interface StsSettings { enabled: boolean; enabledAt: string | null; dcEmail: string }

export async function getStsSettings(): Promise<StsSettings> {
  const { data } = await db().from('clopay_sts_settings').select('auto_request_enabled, auto_request_enabled_at, dc_email').eq('id', true).maybeSingle()
  return {
    enabled: !!data?.auto_request_enabled,
    enabledAt: data?.auto_request_enabled_at ?? null,
    dcEmail: data?.dc_email ?? 'sandiegodc@clopay.com',
  }
}

export async function setStsSettings(enabled: boolean, dcEmail: string, userId: string | null): Promise<void> {
  const patch: Record<string, unknown> = {
    id: true, auto_request_enabled: enabled, dc_email: dcEmail || 'sandiegodc@clopay.com',
    updated_at: new Date().toISOString(), updated_by: userId,
  }
  // Stamp the cutoff whenever it's turned ON so enabling never sweeps the backlog.
  if (enabled) patch.auto_request_enabled_at = new Date().toISOString()
  await db().from('clopay_sts_settings').upsert(patch, { onConflict: 'id' })
}

export interface DcRequestResult { ok: boolean; error?: string }

/** Email the DC for one order's details, then stamp/advance it. */
export async function sendDcRequest(orderId: string): Promise<DcRequestResult> {
  const supabase = db()
  const { data: o } = await supabase
    .from('vendor_orders')
    .select('id, external_id, customer_po, status')
    .eq('id', orderId).eq('vendor', VENDOR)
    .maybeSingle()
  if (!o) return { ok: false, error: 'STS order not found.' }

  const settings = await getStsSettings()
  const orderNo = o.external_id as string
  const po = (o.customer_po as string) || ''
  const subject = `Clopay STS details request — order ${orderNo}`
  const line = `Hello DC,\n\nCan I please get the information for ${orderNo}${po ? ` PO ${po}` : ''}?\n\nThank you,\nCastle Garage Doors`
  const html = `<p>Hello DC,</p><p>Can I please get the information for <strong>${orderNo}</strong>${po ? ` PO ${escapeHtml(po)}` : ''}?</p><p>Thank you,<br/>Castle Garage Doors</p>`

  try {
    await sendEmail({ to: settings.dcEmail, cc: CC_ADDRESS, replyTo: STS_INBOUND_ADDRESS, subject, html, text: line })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  const nowIso = new Date().toISOString()
  const nextStatus = advancedStatus(o.status as string | null, STS_REQUESTED)
  await supabase.from('vendor_orders').update({
    details_requested_at: nowIso, status: nextStatus, updated_at: nowIso,
  }).eq('id', orderId)
  await supabase.from('vendor_order_events').insert({
    order_id: orderId, event_type: 'dc_requested', to_value: nextStatus,
  })
  return { ok: true }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export interface StsAutoRequestResult { enabled: boolean; sent: number; failed: number; remaining: number; errors: string[] }

/** Cron sweep: email the DC once for each new, not-yet-requested STS order. */
export async function runClopayStsAutoRequest(): Promise<StsAutoRequestResult> {
  const s = await getStsSettings()
  if (!s.enabled || !s.enabledAt) return { enabled: false, sent: 0, failed: 0, remaining: 0, errors: [] }
  const supabase = db()

  // Eligible: new (post-enable), not yet requested, not closed.
  const { data: rows } = await supabase
    .from('vendor_orders')
    .select('id, external_id, status, first_seen_at')
    .eq('vendor', VENDOR)
    .is('details_requested_at', null)
    .neq('status', STS_CLOSED)
    .gte('first_seen_at', s.enabledAt)
    .order('first_seen_at', { ascending: true })
    .limit(SEND_CAP)

  const eligible = rows ?? []
  let sent = 0, failed = 0
  const errors: string[] = []
  for (const o of eligible) {
    const res = await sendDcRequest(o.id as string)
    if (res.ok) sent++
    else { failed++; errors.push(`order ${o.external_id}: ${res.error ?? 'failed'}`) }
    await sleep(1200)
  }
  return { enabled: true, sent, failed, remaining: Math.max(0, eligible.length - sent - failed), errors }
}
