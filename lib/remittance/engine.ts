import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { RawInboundEmail } from '@/lib/inbound/resend'
import { detectVendor, parseRemittance, type ParsedRemittance } from './parse'
import { matchLine } from './match'
import { isAiMatchConfigured, buildCandidates, aiSuggestMatch } from './ai-match'

// Ingest one remittance email: detect vendor → parse → match each line → store a
// remittance_emails record (with the raw copy retained) plus one
// remittance_payments row per line, in the review queue. Applying to SF is a
// separate, human-gated step. Idempotent on resend_email_id and per-line dedup key.

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

/** Best-effort plain text from the email (for the archive), preferring text. */
function rawText(email: RawInboundEmail): string {
  if (email.text && email.text.trim()) return email.text
  return (email.html ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
}

export interface IngestResult { ok: boolean; status: string; emailId?: string; vendor?: string; lines?: number }

export async function ingestRemittance(email: RawInboundEmail, resendId: string | null): Promise<IngestResult> {
  const supabase = db()

  // Idempotency: same received email is ingested once.
  if (resendId) {
    const { data: existing } = await supabase.from('remittance_emails').select('id').eq('resend_email_id', resendId).maybeSingle()
    if (existing) return { ok: true, status: 'duplicate', emailId: (existing as { id: string }).id }
  }

  const html = email.html ?? ''
  const vendor = detectVendor(email.from, html)
  if (!vendor) {
    const { data } = await supabase.from('remittance_emails').insert({
      resend_email_id: resendId, from_addr: email.from, subject: email.subject,
      raw_text: rawText(email), raw_html: html, status: 'error', error: 'unrecognized vendor',
    }).select('id').single()
    return { ok: false, status: 'error', emailId: (data as { id: string } | null)?.id }
  }

  const parsed: ParsedRemittance = parseRemittance(vendor, html)

  const { data: emailRow, error: insErr } = await supabase.from('remittance_emails').insert({
    vendor_id: vendor,
    resend_email_id: resendId,
    from_addr: email.from,
    subject: email.subject,
    payment_reference: parsed.payment_reference,
    payment_date: parsed.payment_date,
    payment_amount: parsed.payment_amount,
    raw_text: rawText(email),
    raw_html: html,
    status: 'needs_review',
  }).select('id').single()
  if (insErr || !emailRow) return { ok: false, status: 'error' }
  const emailId = (emailRow as { id: string }).id

  let lineNo = 0
  for (const line of parsed.lines) {
    lineNo++
    const m = await matchLine(supabase, vendor, line)
    const dedupKey = `${vendor}:${parsed.payment_reference ?? ''}:${lineNo}:${line.vendor_ref ?? ''}:${line.amount}`
    await supabase.from('remittance_payments').insert({
      email_id: emailId,
      line_no: lineNo,
      po: line.po,
      customer_name: line.customer_name,
      vendor_ref: line.vendor_ref,
      amount: line.amount,
      doc_date: line.doc_date,
      match_status: m.match_status,
      match_method: m.match_method,
      sf_job_id: m.sf_job_id,
      sf_job_number: m.sf_job_number,
      matched_customer: m.matched_customer,
      open_amount: m.open_amount,
      match_confidence: m.match_confidence,
      candidates: m.candidates,
      dedup_key: dedupKey,
    })
  }

  return { ok: true, status: 'needs_review', emailId, vendor, lines: parsed.lines.length }
}

// Re-run matching on every not-yet-applied line with the current matcher (e.g.
// after a matching-logic change). Only touches lines still in review — applied /
// approved lines are left alone — so it's safe to run repeatedly.
export async function rematchPending(): Promise<{ updated: number }> {
  const supabase = db()
  const { data: emailRows } = await supabase.from('remittance_emails').select('id, vendor_id')
  const vendorByEmail = new Map<string, string | null>((emailRows ?? []).map((e: { id: string; vendor_id: string | null }) => [e.id, e.vendor_id]))

  const { data: rows } = await supabase
    .from('remittance_payments')
    .select('id, email_id, po, customer_name, vendor_ref, amount, doc_date, apply_status')
    .in('apply_status', ['pending', 'failed'])
  const lines = (rows ?? []) as Array<{ id: string; email_id: string; po: string | null; customer_name: string | null; vendor_ref: string | null; amount: number; doc_date: string | null }>

  let updated = 0
  for (const row of lines) {
    const vendor = vendorByEmail.get(row.email_id)
    if (vendor !== 'clopay' && vendor !== 'overhead_door') continue
    const m = await matchLine(supabase, vendor, { po: row.po, customer_name: row.customer_name, vendor_ref: row.vendor_ref, amount: row.amount, doc_date: row.doc_date })
    await supabase.from('remittance_payments').update({
      match_status: m.match_status,
      match_method: m.match_method,
      sf_job_id: m.sf_job_id,
      sf_job_number: m.sf_job_number,
      matched_customer: m.matched_customer,
      open_amount: m.open_amount,
      match_confidence: m.match_confidence,
      candidates: m.candidates,
    }).eq('id', row.id)
    updated++
  }
  return { updated }
}

// AI residual review: for lines deterministic matching left as no_match/ambiguous
// and not yet AI-reviewed, ask the model to suggest a job or abstain. Stores an
// advisory suggestion only — never changes match_status/sf_job_id. No-op without
// ANTHROPIC_API_KEY.
export async function aiReviewPending(): Promise<{ reviewed: number; suggested: number }> {
  if (!isAiMatchConfigured()) return { reviewed: 0, suggested: 0 }
  const supabase = db()
  const { data: rows } = await supabase
    .from('remittance_payments')
    .select('id, po, customer_name, vendor_ref, amount, doc_date, match_status, apply_status, ai_reviewed_at')
    .in('match_status', ['no_match', 'ambiguous'])
    .in('apply_status', ['pending', 'failed'])
    .is('ai_reviewed_at', null)
  const lines = (rows ?? []) as Array<{ id: string; po: string | null; customer_name: string | null; vendor_ref: string | null; amount: number; doc_date: string | null }>

  let reviewed = 0, suggested = 0
  for (const row of lines) {
    const line = { po: row.po, customer_name: row.customer_name, vendor_ref: row.vendor_ref, amount: row.amount, doc_date: row.doc_date }
    const candidates = await buildCandidates(supabase, line)
    const sug = await aiSuggestMatch(line, candidates)
    reviewed++
    const update: Record<string, unknown> = { ai_reviewed_at: new Date().toISOString() }
    if (sug?.job_id) {
      update.ai_suggested_job_id = sug.job_id
      update.ai_suggested_job_number = sug.job_number
      update.ai_suggested_customer = sug.customer_name
      update.ai_confidence = sug.confidence
      update.ai_reason = sug.reason
      suggested++
    } else if (sug) {
      update.ai_confidence = 0
      update.ai_reason = sug.reason // explicit abstention, reason retained
    }
    await supabase.from('remittance_payments').update(update).eq('id', row.id)
  }
  return { reviewed, suggested }
}
