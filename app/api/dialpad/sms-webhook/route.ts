import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { sendSms, toE164 } from '@/lib/dialpad/client'
import { handleLeadReply } from '@/lib/leadgen/engine'

export const maxDuration = 30

// Inbound SMS webhook from Dialpad — honors STOP / HELP / START for invoice
// reminders. Dialpad signs the event as a JWT (HS256) with DIALPAD_WEBHOOK_SECRET
// when a secret is configured; we verify it when present. Always returns 200 so
// Dialpad doesn't retry-storm.

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

function b64urlDecode(s: string): string {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}

// Returns the decoded event payload, or null if a JWT failed verification.
function decodeEvent(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim()
  // JWT? three dot-separated base64url segments.
  const parts = trimmed.split('.')
  if (parts.length === 3) {
    const secret = process.env.DIALPAD_WEBHOOK_SECRET
    if (secret) {
      const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      if (expected !== parts[2]) return null
    }
    try { return JSON.parse(b64urlDecode(parts[1])) } catch { return null }
  }
  try { return JSON.parse(trimmed) } catch { return null }
}

const STOP_WORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|optout|opt-out)\s*$/i
const START_WORDS = /^\s*(start|unstop|yes|resume|optin|opt-in)\s*$/i
const HELP_WORDS = /^\s*help\s*$/i

export async function POST(req: NextRequest) {
  let raw = ''
  try { raw = await req.text() } catch { return NextResponse.json({ ok: true }) }

  const supabase = db()
  // Log every inbound POST verbatim, so we can see exactly what Dialpad sends
  // (field names, whether STOP is even forwarded) — then decide what to do.
  async function logEvent(fields: { verified: boolean; from_number: string | null; message_text: string | null; action: string }) {
    try { await supabase.from('dialpad_inbound_events').insert({ ...fields, raw_body: raw.slice(0, 4000) }) } catch { /* non-critical */ }
  }

  const evt = decodeEvent(raw)
  if (!evt) { await logEvent({ verified: false, from_number: null, message_text: null, action: 'unverified' }); return NextResponse.json({ ok: true, ignored: 'unverified or unparseable' }) }

  // Best-effort field extraction across possible shapes.
  const text = String((evt.text as string) ?? (evt.message as string) ?? (evt.body as string) ?? '')
  const fromRaw = (evt.from_number as string) ?? (evt.from as string) ?? (evt.contact_phone as string) ?? (evt.mobile_number as string) ?? null
  const from = toE164(fromRaw)

  const direction = (evt.direction as string) ?? (evt.event as string) ?? ''
  if (direction && !/inbound|received/i.test(direction)) { await logEvent({ verified: true, from_number: from, message_text: text, action: 'ignored' }); return NextResponse.json({ ok: true, ignored: 'not inbound' }) }
  if (!from) { await logEvent({ verified: true, from_number: null, message_text: text, action: 'ignored' }); return NextResponse.json({ ok: true, ignored: 'no from number' }) }

  if (STOP_WORDS.test(text)) {
    await logEvent({ verified: true, from_number: from, message_text: text, action: 'opted_out' })
    await supabase.from('invoice_reminder_optouts')
      .upsert({ channel: 'sms', value: from, reason: 'stop' }, { onConflict: 'channel,value' })
    await sendSms(from, 'You have been unsubscribed from Castle Garage Inc messages and will not receive further texts. Reply START to resubscribe.').catch(() => {})
    return NextResponse.json({ ok: true, action: 'opted_out' })
  }

  if (START_WORDS.test(text)) {
    await logEvent({ verified: true, from_number: from, message_text: text, action: 'opted_in' })
    await supabase.from('invoice_reminder_optouts').delete().eq('channel', 'sms').eq('value', from)
    await sendSms(from, 'You have been resubscribed to Castle Garage Inc messages. Reply STOP to opt out.').catch(() => {})
    return NextResponse.json({ ok: true, action: 'opted_in' })
  }

  if (HELP_WORDS.test(text)) {
    await logEvent({ verified: true, from_number: from, message_text: text, action: 'help' })
    await sendSms(from, 'Castle Garage Inc: for help call us, or reply STOP to opt out. Msg & data rates may apply.').catch(() => {})
    return NextResponse.json({ ok: true, action: 'help' })
  }

  // Lead outreach replies: "1" = request a callback, "2" = no longer interested.
  // Only acts if this number has a recent active lead; otherwise falls through.
  try {
    const leadAction = await handleLeadReply(from, text)
    if (leadAction) {
      await logEvent({ verified: true, from_number: from, message_text: text, action: `lead_${leadAction}` })
      return NextResponse.json({ ok: true, action: `lead_${leadAction}` })
    }
  } catch { /* non-critical — fall through to noop */ }

  await logEvent({ verified: true, from_number: from, message_text: text, action: 'noop' })
  return NextResponse.json({ ok: true, action: 'noop' })
}
