import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { sendEmail } from '@/lib/notifications/resend'
import { sendSms, toE164, isDialpadConfigured } from '@/lib/dialpad/client'
import { greetingFirstName } from '@/lib/names'
import { renderLeadOutreachEmail } from '@/lib/notifications/templates/lead-outreach-email'
import { renderLeadSms, REPLY_CALLBACK_ACK, REPLY_NOT_INTERESTED_ACK } from './templates'
import { ensureShortLink, shortCode } from '@/lib/short-links'
import type { ParsedLead } from './parse'

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

export interface LeadRow {
  id: string
  provider: string
  external_id: string | null
  customer_name: string | null
  greeting_name: string | null
  phone_raw: string | null
  phone_e164: string | null
  email: string | null
  address_street: string | null
  address_city: string | null
  address_state: string | null
  address_postal: string | null
  program_name: string | null
  source: string | null
  referral_store: string | null
  lead_notes: string | null
  received_at: string
  status: string
  held_reason: string | null
  email_sent_at: string | null
  sms_sent_at: string | null
  sms_status: string | null
  send_error: string | null
  reply_text: string | null
  replied_at: string | null
  matched_job_id: string | null
  converted_at: string | null
  outreach_link_code: string | null
}

export interface LeadGenSettings { enabled: boolean; self_schedule_url: string; reply_to_email: string | null }

export async function loadLeadGenSettings(): Promise<LeadGenSettings> {
  const { data } = await db().from('leadgen_settings').select('enabled, self_schedule_url, reply_to_email').eq('id', 1).maybeSingle()
  return {
    enabled: data?.enabled ?? false,
    self_schedule_url: (data?.self_schedule_url as string) || 'sfi.cstle.co',
    reply_to_email: (data?.reply_to_email as string) || null,
  }
}

/** Record what an inbound webhook delivered, for visibility/debugging. */
export async function logInboundEvent(fields: {
  from_addr: string | null
  subject: string | null
  resend_email_id: string | null
  outcome: string
  lead_id?: string | null
  detail?: string | null
}): Promise<void> {
  try { await db().from('leadgen_inbound_events').insert(fields) } catch { /* non-critical */ }
}

// ── helpers ──────────────────────────────────────────────────────────────────
const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '')
const last10 = (s: string | null | undefined) => { const d = digits(s); return d.length >= 10 ? d.slice(-10) : '' }
const normName = (s: string | null | undefined) =>
  (s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()

/** Customer ids in the SF mirror whose contact phone/email matches this lead. */
async function customerIdsByContact(phoneE164: string | null, email: string | null): Promise<Set<string>> {
  const supabase = db()
  const contactIds = new Set<string>()

  if (email) {
    const { data } = await supabase.from('sf_contact_emails').select('contact_id, email').ilike('email', email)
    for (const r of data ?? []) if ((r.email as string)?.toLowerCase() === email.toLowerCase()) contactIds.add(r.contact_id as string)
  }
  const l10 = last10(phoneE164)
  if (l10) {
    const { data } = await supabase.from('sf_contact_phones').select('contact_id, phone').ilike('phone', `%${l10.slice(-4)}%`)
    for (const r of data ?? []) if (last10(r.phone as string) === l10) contactIds.add(r.contact_id as string)
  }
  if (contactIds.size === 0) return new Set()

  const { data: contacts } = await supabase
    .from('sf_customer_contacts').select('customer_id').in('id', [...contactIds])
  return new Set((contacts ?? []).map(c => c.customer_id as string).filter(Boolean))
}

/** An existing OPEN job for a customer we already know (phone/email match). */
async function findActiveCustomerJobId(phoneE164: string | null, email: string | null): Promise<string | null> {
  const customerIds = await customerIdsByContact(phoneE164, email)
  if (customerIds.size === 0) return null
  const { data } = await db()
    .from('sf_jobs').select('id, closed_at, is_deleted')
    .in('customer_id', [...customerIds]).eq('is_deleted', false).is('closed_at', null)
    .limit(1)
  return (data?.[0]?.id as string) ?? null
}

/** A job created AFTER the lead came in that matches it — i.e. the lead booked. */
async function findConvertingJobId(lead: LeadRow): Promise<string | null> {
  const supabase = db()
  // Small buffer so a job entered a few minutes before the email lands still counts.
  const since = new Date(new Date(lead.received_at).getTime() - 24 * 3600 * 1000).toISOString()

  // 1) Contact match (phone/email) → newest qualifying job.
  const customerIds = await customerIdsByContact(lead.phone_e164, lead.email)
  if (customerIds.size > 0) {
    const { data } = await supabase
      .from('sf_jobs').select('id, created_at_sf')
      .in('customer_id', [...customerIds]).eq('is_deleted', false).gte('created_at_sf', since)
      .order('created_at_sf', { ascending: true }).limit(1)
    if (data?.[0]) return data[0].id as string
  }

  // 2) Fallback: name + postal on the job record itself.
  const nm = normName(lead.customer_name)
  if (nm && lead.address_postal) {
    const { data } = await supabase
      .from('sf_jobs').select('id, customer_name, contact_first_name, contact_last_name, postal_code, created_at_sf')
      .eq('is_deleted', false).eq('postal_code', lead.address_postal).gte('created_at_sf', since)
      .order('created_at_sf', { ascending: true }).limit(50)
    for (const j of data ?? []) {
      const jobName = normName(j.customer_name as string) ||
        normName(`${j.contact_first_name ?? ''} ${j.contact_last_name ?? ''}`)
      if (jobName && (jobName === nm || jobName.includes(nm) || nm.includes(jobName))) return j.id as string
    }
  }
  return null
}

// ── ingest ───────────────────────────────────────────────────────────────────
export interface IngestResult { leadId: string | null; status: string; sent: ('email' | 'sms')[] }

/** Insert a parsed lead (dedup + existing-customer guard) and auto-send if on. */
export async function ingestLead(parsed: ParsedLead, rawText: string): Promise<IngestResult> {
  const supabase = db()
  const phoneE164 = toE164(parsed.phoneRaw)
  const email = parsed.email?.toLowerCase() ?? null
  const greeting = greetingFirstName({ customerName: parsed.customerName })

  // Exact re-forward guard.
  const contentHash = crypto.createHash('sha256').update(rawText.trim()).digest('hex')
  const { data: dup } = await supabase.from('leads').select('id').eq('content_hash', contentHash).maybeSingle()
  if (dup) return { leadId: dup.id as string, status: 'duplicate', sent: [] }

  // Near-duplicate: same phone or email seen in the last 2 days.
  const windowStart = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString()
  if (phoneE164 || email) {
    let q = supabase.from('leads').select('id').gte('received_at', windowStart)
    q = phoneE164 && email ? q.or(`phone_e164.eq.${phoneE164},email.eq.${email}`)
      : phoneE164 ? q.eq('phone_e164', phoneE164) : q.eq('email', email!)
    const { data: recent } = await q.limit(1)
    if (recent && recent.length) {
      await insertLead(parsed, phoneE164, email, greeting, rawText, contentHash, 'duplicate', 'recent lead with same contact')
      return { leadId: recent[0].id as string, status: 'duplicate', sent: [] }
    }
  }

  // Existing-customer guard: hold instead of cold-contacting someone we're
  // already working with.
  const activeJob = await findActiveCustomerJobId(phoneE164, email)
  if (activeJob) {
    const id = await insertLead(parsed, phoneE164, email, greeting, rawText, contentHash, 'held', `existing open job ${activeJob}`)
    return { leadId: id, status: 'held', sent: [] }
  }

  const leadId = await insertLead(parsed, phoneE164, email, greeting, rawText, contentHash, 'new', null)

  const settings = await loadLeadGenSettings()
  if (!settings.enabled) return { leadId, status: 'new', sent: [] }

  const lead = await getLead(leadId)
  if (!lead) return { leadId, status: 'new', sent: [] }
  const sent = await sendLeadOutreach(lead, settings)
  return { leadId, status: sent.length ? 'contacted' : 'no_contact', sent }
}

async function insertLead(
  parsed: ParsedLead, phoneE164: string | null, email: string | null, greeting: string | null,
  rawText: string, contentHash: string, status: string, heldReason: string | null,
): Promise<string> {
  const { data, error } = await db().from('leads').insert({
    provider: parsed.provider,
    external_id: parsed.externalId,
    customer_name: parsed.customerName,
    greeting_name: greeting,
    phone_raw: parsed.phoneRaw,
    phone_e164: phoneE164,
    email,
    address_street: parsed.addressStreet,
    address_city: parsed.addressCity,
    address_state: parsed.addressState,
    address_postal: parsed.addressPostal,
    program_name: parsed.programName,
    source: parsed.source,
    referral_store: parsed.referralStore,
    lead_notes: parsed.notes,
    raw_email: rawText.slice(0, 20000),
    content_hash: contentHash,
    status,
    held_reason: heldReason,
  }).select('id').single()
  if (error) throw new Error(error.message)
  return data.id as string
}

export async function getLead(id: string): Promise<LeadRow | null> {
  const { data } = await db().from('leads').select('*').eq('id', id).maybeSingle()
  return (data as LeadRow) ?? null
}

// ── outbound ─────────────────────────────────────────────────────────────────
/** Send the first-touch email + SMS to a lead. Records what went out. */
export async function sendLeadOutreach(lead: LeadRow, settings?: LeadGenSettings): Promise<('email' | 'sms')[]> {
  const cfg = settings ?? await loadLeadGenSettings()
  const supabase = db()
  const sent: ('email' | 'sms')[] = []
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }

  // Per-lead trackable scheduler link (Phase 1 attribution). Wrap the configured
  // self-schedule destination in a short link whose target carries this lead's id
  // — that makes each code unique per lead, so a click maps back to the lead via
  // short_links.click_count (and sets up exact booking attribution later via the
  // ?sfi= param). Falls back to the plain URL if the shortener is unavailable.
  const baseUrl = /^https?:\/\//i.test(cfg.self_schedule_url) ? cfg.self_schedule_url : `https://${cfg.self_schedule_url.replace(/^\/+/, '')}`
  const target = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}sfi=${encodeURIComponent(lead.id)}`
  const scheduleLink = await ensureShortLink(target).catch(() => baseUrl)
  if (!lead.outreach_link_code) patch.outreach_link_code = shortCode(target)

  // Email
  if (lead.email && !lead.email_sent_at) {
    try {
      const { html, text } = renderLeadOutreachEmail({ greetingName: lead.greeting_name, scheduleUrl: scheduleLink })
      await sendEmail({ to: lead.email, subject: 'Castle Garage Doors & Gates — your Home Depot service request', html, text, replyTo: cfg.reply_to_email || undefined })
      patch.email_sent_at = new Date().toISOString()
      sent.push('email')
    } catch (e) {
      patch.send_error = e instanceof Error ? e.message : String(e)
    }
  }

  // SMS (skip if opted out)
  if (lead.phone_e164 && !lead.sms_sent_at && isDialpadConfigured()) {
    const { data: opt } = await supabase.from('invoice_reminder_optouts')
      .select('value').eq('channel', 'sms').eq('value', lead.phone_e164).maybeSingle()
    if (!opt) {
      const res = await sendSms(lead.phone_e164, renderLeadSms(scheduleLink))
      patch.sms_sent_at = new Date().toISOString()
      patch.sms_status = res.ok ? 'sent' : 'failed'
      patch.sms_message_id = res.messageId
      if (res.ok) sent.push('sms')
      else patch.send_error = res.error ?? 'sms failed'
    }
  }

  // Status: contacted if anything went out; otherwise no_contact only when we
  // truly have no channel (don't downgrade a lead that's mid-retry).
  const anySentEver = sent.length > 0 || lead.email_sent_at || lead.sms_sent_at
  if (anySentEver) patch.status = 'contacted'
  else if (!lead.email && !lead.phone_e164) patch.status = 'no_contact'

  await supabase.from('leads').update(patch).eq('id', lead.id)
  return sent
}

// ── inbound replies (1 = callback, 2 = not interested) ───────────────────────
const REPLY_CALLBACK = /^\s*1\b/
const REPLY_NOT_INTERESTED = /^\s*2\b/

/**
 * Handle a customer's SMS reply to a lead outreach. Returns the action taken, or
 * null if this number has no recent active lead (so the caller can ignore it).
 */
export async function handleLeadReply(fromE164: string, text: string): Promise<'callback' | 'not_interested' | null> {
  const supabase = db()
  const since = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString()
  const { data } = await supabase.from('leads')
    .select('id, status')
    .eq('phone_e164', fromE164)
    .gte('received_at', since)
    .in('status', ['new', 'held', 'contacted', 'callback', 'no_contact'])
    .order('received_at', { ascending: false })
    .limit(1)
  const lead = data?.[0]
  if (!lead) return null

  let action: 'callback' | 'not_interested' | null = null
  if (REPLY_NOT_INTERESTED.test(text)) action = 'not_interested'
  else if (REPLY_CALLBACK.test(text)) action = 'callback'
  if (!action) return null

  await supabase.from('leads').update({
    status: action,
    reply_text: text.slice(0, 500),
    replied_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', lead.id)

  const ack = action === 'callback' ? REPLY_CALLBACK_ACK : REPLY_NOT_INTERESTED_ACK
  await sendSms(fromE164, ack).catch(() => {})
  return action
}

// ── conversion matching ──────────────────────────────────────────────────────
export interface MatchResult { checked: number; booked: number }

/** Scan open leads and mark any that now have a matching SF job as booked. */
export async function matchConversions(): Promise<MatchResult> {
  const supabase = db()
  const { data } = await supabase.from('leads').select('*')
    .in('status', ['new', 'held', 'contacted', 'callback', 'no_contact'])
    .is('matched_job_id', null)
    .order('received_at', { ascending: false })
    .limit(500)
  const leads = (data ?? []) as LeadRow[]
  let booked = 0
  for (const lead of leads) {
    try {
      const jobId = await findConvertingJobId(lead)
      if (jobId) {
        await supabase.from('leads').update({
          status: 'booked', matched_job_id: jobId, converted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }).eq('id', lead.id)
        booked++
      }
    } catch (e) {
      // One malformed lead must not abort the whole batch (and, before isolation,
      // the entire cron — which blocked SF customer pre-creation).
      console.error('[leadgen] matchConversions failed for lead', lead.id, e instanceof Error ? e.message : e)
    }
  }
  return { checked: leads.length, booked }
}
