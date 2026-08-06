import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Server side of the browser-extension apply flow. Service Fusion has no API to
// add a payment to an existing job (PUT /jobs → 405), so the actual posting is
// done by a Chrome extension that drives SF's web form in the user's logged-in
// session. This module is the queue the extension reads and the callback it
// writes back to — the app stays the source of truth (matching, approval,
// idempotency, audit); the extension is only the arm that clicks.
//
// State machine (apply_status): pending → approved → applied | failed. A human
// approves (or autopilot approves confident PO matches); the extension posts
// approved lines and calls back with the result. Excluded lines are skipped.

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

// Payment type recorded in SF. "Other" (980387038) per the account's convention;
// pay-type CHECK mirrors the known-good manual submission. Override via env.
const SF_PAYMENT_TYPE_ID = process.env.REMITTANCE_SF_PAYMENT_TYPE_ID || '980387038'
const SF_PAY_TYPE = process.env.REMITTANCE_SF_PAY_TYPE || 'CHECK'

const vendorLabel = (v: string | null) => v === 'clopay' ? 'Clopay' : v === 'overhead_door' ? 'Overhead Door' : (v ?? 'Vendor')

/** "Aug 4, 2026" / ISO → "MM/DD/YYYY" (SF's received_on format), or null. */
function toMdY(s: string | null): string | null {
  if (!s) return null
  const d = new Date(s)
  if (isNaN(d.getTime())) return null
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`
}

export interface ApplyQueueItem {
  lineId: string
  /** SF invoice NUMBER the payment applies to (the extension resolves it to the
   *  hashed web id). */
  invoiceNumber: string
  jobNumber: string | null
  customerName: string | null
  amount: number
  reference: string
  receivedOn: string | null
  memo: string
  paymentTypeId: string
  payType: string
}

/** The single open invoice number for a job, or null if 0 / >1 (ambiguous). */
async function openInvoiceForJob(supabase: SupabaseClient, jobId: string): Promise<string | null> {
  const { data } = await supabase.from('sf_invoices').select('number, is_paid').eq('job_id', jobId).eq('is_deleted', false)
  const open = ((data ?? []) as Array<{ number: string | null; is_paid: boolean | null }>).filter(r => !r.is_paid && r.number)
  return open.length === 1 ? open[0].number : null
}

/** Approved, matched, not-yet-applied lines with everything the extension needs
 *  to post. Lines whose job has no single open invoice are returned with a
 *  `skipReason` so the extension can flag rather than guess. */
export async function getApplyQueue(): Promise<{ items: ApplyQueueItem[]; skipped: Array<{ lineId: string; reason: string }> }> {
  const supabase = db()
  const { data: rows } = await supabase
    .from('remittance_payments')
    .select('id, email_id, po, customer_name, vendor_ref, amount, sf_job_id, sf_job_number, matched_customer, match_status, apply_status')
    .eq('apply_status', 'approved')
    .eq('match_status', 'matched')
  const lines = (rows ?? []) as Array<{ id: string; email_id: string; po: string | null; customer_name: string | null; vendor_ref: string | null; amount: number; sf_job_id: string | null; sf_job_number: string | null; matched_customer: string | null }>
  if (lines.length === 0) return { items: [], skipped: [] }

  // Email context (vendor + payment reference/date) for the queued lines.
  const emailIds = [...new Set(lines.map(l => l.email_id))]
  const { data: emails } = await supabase.from('remittance_emails').select('id, vendor_id, payment_reference, payment_date').in('id', emailIds)
  const emailById = new Map((emails ?? []).map((e: { id: string; vendor_id: string | null; payment_reference: string | null; payment_date: string | null }) => [e.id, e]))

  const items: ApplyQueueItem[] = []
  const skipped: Array<{ lineId: string; reason: string }> = []
  for (const l of lines) {
    if (!l.sf_job_id) { skipped.push({ lineId: l.id, reason: 'no job' }); continue }
    const invoiceNumber = await openInvoiceForJob(supabase, l.sf_job_id)
    if (!invoiceNumber) { skipped.push({ lineId: l.id, reason: 'no single open invoice' }); continue }
    const email = emailById.get(l.email_id)
    const memo = [vendorLabel(email?.vendor_id ?? null), email?.payment_reference ? `remit ${email.payment_reference}` : null, l.vendor_ref, l.customer_name, l.po ? `PO ${l.po}` : null].filter(Boolean).join(' · ')
    items.push({
      lineId: l.id,
      invoiceNumber,
      jobNumber: l.sf_job_number,
      customerName: l.matched_customer,
      amount: l.amount,
      reference: email?.payment_reference ?? '',
      receivedOn: toMdY(email?.payment_date ?? null),
      memo,
      paymentTypeId: SF_PAYMENT_TYPE_ID,
      payType: SF_PAY_TYPE,
    })
  }
  return { items, skipped }
}

/** Extension callback: record the outcome of posting one line to SF. */
export async function recordApplyResult(lineId: string, result: { ok: boolean; sfPaymentId?: string | null; sfResponse?: unknown; error?: string }): Promise<{ ok: boolean; error?: string }> {
  const supabase = db()
  const { data: guard } = await supabase.from('remittance_payments').select('apply_status, amount, email_id').eq('id', lineId).maybeSingle()
  if (!guard) return { ok: false, error: 'line not found' }
  if (guard.apply_status === 'applied') return { ok: true } // idempotent — already recorded

  const update: Record<string, unknown> = result.ok
    ? { apply_status: 'applied', applied_amount: guard.amount, applied_at: new Date().toISOString(), sf_payment_response: { sfPaymentId: result.sfPaymentId ?? null, response: result.sfResponse ?? null }, error: null }
    : { apply_status: 'failed', error: result.error ?? 'unknown error' }
  await supabase.from('remittance_payments').update(update).eq('id', lineId).neq('apply_status', 'applied')
  await refreshEmailStatus(supabase, (guard as { email_id: string }).email_id)
  return { ok: true }
}

/** Approve / unapprove a matched line for the extension to post. */
export async function setApproved(lineId: string, approved: boolean): Promise<{ ok: boolean; error?: string }> {
  const supabase = db()
  const status = approved ? 'approved' : 'pending'
  const { data } = await supabase.from('remittance_payments')
    .update({ apply_status: status })
    .eq('id', lineId).eq('match_status', 'matched').in('apply_status', ['pending', 'approved', 'failed']).select('id, email_id')
  if (!data || data.length === 0) return { ok: false, error: 'line not matched or already applied' }
  await refreshEmailStatus(supabase, (data[0] as { email_id: string }).email_id)
  return { ok: true }
}

/** Roll an email's status up from its lines. */
export async function refreshEmailStatus(supabase: SupabaseClient, emailId: string): Promise<void> {
  const { data } = await supabase.from('remittance_payments').select('apply_status').eq('email_id', emailId)
  const rows = (data ?? []) as Array<{ apply_status: string }>
  const active = rows.filter(r => r.apply_status !== 'excluded')
  const applied = active.filter(r => r.apply_status === 'applied').length
  let status = 'needs_review'
  if (active.length > 0 && applied === active.length) status = 'applied'
  else if (applied > 0) status = 'partial'
  await supabase.from('remittance_emails').update({ status }).eq('id', emailId)
}
