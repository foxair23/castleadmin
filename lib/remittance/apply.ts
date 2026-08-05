import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { sfGet, sfPut } from '@/lib/crm/service-fusion'

// Post a matched remittance line to its Service Fusion job as a payment.
//
// SF records payments in a job's `payments` array (typ.Payment: amount,
// reference_number, memo, received_on, apply_to). The API docs don't state
// whether PUT /jobs replaces or appends that array, and sending existing
// payments back is unsafe either way (replace → sending only the new one wipes
// them; append → re-sending duplicates them). Until that behavior is verified on
// a supervised post, we only post to jobs with ZERO existing payments, where
// both semantics are identical — see APPLY_ALLOW_EXISTING_PAYMENTS.
//
// Guarded for money: a line must be matched + have an sf_job_id, and is marked
// applied only after SF returns success. Idempotent — never re-posts an applied
// line.

// Lift once SF's append-vs-replace behavior is confirmed on a real post.
const ALLOW_EXISTING_PAYMENTS = process.env.REMITTANCE_APPLY_ALLOW_EXISTING === '1'

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

const vendorLabel = (v: string | null) => v === 'clopay' ? 'Clopay' : v === 'overhead_door' ? 'Overhead Door' : (v ?? 'Vendor')

// Roll an email's status up from its lines: applied when every non-excluded line
// is applied, partial when some are, else needs_review.
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

// Exclude / un-exclude a line (skip it — e.g. handled manually in SF). Never
// touches an already-applied line.
export async function setLineExcluded(lineId: string, excluded: boolean): Promise<{ ok: boolean; error?: string }> {
  const supabase = db()
  const { data } = await supabase.from('remittance_payments')
    .update({ apply_status: excluded ? 'excluded' : 'pending' })
    .eq('id', lineId).neq('apply_status', 'applied').select('id, email_id')
  if (!data || data.length === 0) return { ok: false, error: 'Line not found or already applied.' }
  await refreshEmailStatus(supabase, (data[0] as { email_id: string }).email_id)
  return { ok: true }
}

/** "Aug 4, 2026" / ISO → "YYYY-MM-DD", or null. */
function toDateOnly(s: string | null): string | null {
  if (!s) return null
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

export interface SfPayment { amount: number; reference_number: string; memo: string; received_on: string | null; apply_to: string | null }
export interface PaymentPreview {
  lineId: string
  jobId: string
  jobNumber: string | null
  customerName: string | null
  existingPaymentCount: number
  safeToApply: boolean            // true when it can post now (no existing payments, or override on)
  payment: SfPayment
  warnings: string[]
}

interface LineRow {
  id: string; email_id: string; po: string | null; customer_name: string | null; vendor_ref: string | null
  amount: number; sf_job_id: string | null; sf_job_number: string | null; matched_customer: string | null
  match_status: string; apply_status: string
}

async function loadLine(supabase: SupabaseClient, lineId: string): Promise<{ line: LineRow; vendorId: string | null; paymentRef: string | null; paymentDate: string | null } | null> {
  const { data: line } = await supabase.from('remittance_payments')
    .select('id, email_id, po, customer_name, vendor_ref, amount, sf_job_id, sf_job_number, matched_customer, match_status, apply_status')
    .eq('id', lineId).maybeSingle()
  if (!line) return null
  const { data: email } = await supabase.from('remittance_emails').select('vendor_id, payment_reference, payment_date').eq('id', (line as LineRow).email_id).maybeSingle()
  return { line: line as LineRow, vendorId: email?.vendor_id ?? null, paymentRef: email?.payment_reference ?? null, paymentDate: email?.payment_date ?? null }
}

/** Open invoice number for a job (for apply_to), from the mirror. Null unless
 *  there's exactly one open invoice. */
async function openInvoiceNumber(supabase: SupabaseClient, jobId: string): Promise<{ number: string | null; openCount: number }> {
  const { data } = await supabase.from('sf_invoices').select('number, is_paid').eq('job_id', jobId).eq('is_deleted', false)
  const open = ((data ?? []) as Array<{ number: string | null; is_paid: boolean | null }>).filter(r => !r.is_paid)
  return { number: open.length === 1 ? open[0].number : null, openCount: open.length }
}

/** How many payments the job already has in SF (live). */
async function existingPayments(jobId: string): Promise<unknown[]> {
  const json = await sfGet(`/jobs/${encodeURIComponent(jobId)}`, { expand: 'payments' }) as Record<string, unknown>
  const job = (Array.isArray(json?.items) ? json.items[0] : (json?.id ? json : json?.data)) as Record<string, unknown> | undefined
  const payments = job?.payments
  return Array.isArray(payments) ? payments : []
}

/** Build the exact payload we'd post — WITHOUT posting. */
export async function previewLine(lineId: string): Promise<{ preview?: PaymentPreview; error?: string }> {
  const supabase = db()
  const ctx = await loadLine(supabase, lineId)
  if (!ctx) return { error: 'Line not found.' }
  const { line, vendorId, paymentRef, paymentDate } = ctx
  if (line.match_status !== 'matched' || !line.sf_job_id) return { error: 'Line is not matched to a job.' }

  const warnings: string[] = []
  const { number: applyTo, openCount } = await openInvoiceNumber(supabase, line.sf_job_id)
  if (openCount === 0) warnings.push('No open invoice on this job — the payment will apply as a credit.')
  else if (openCount > 1) warnings.push(`Job has ${openCount} open invoices — apply-to left blank; verify which invoice.`)

  let existingCount = 0
  let readOk = true
  try { existingCount = (await existingPayments(line.sf_job_id)).length }
  catch (e) { readOk = false; warnings.push(`Could not read existing payments (posting blocked): ${e instanceof Error ? e.message : String(e)}`) }
  if (existingCount > 0) warnings.push(`Job already has ${existingCount} payment(s) in SF. Blocked until append-vs-replace behavior is verified (set REMITTANCE_APPLY_ALLOW_EXISTING=1 to override).`)
  // If we couldn't read existing payments, never treat the job as safe to post.
  const safeToApply = readOk && (existingCount === 0 || ALLOW_EXISTING_PAYMENTS)

  const memo = [vendorLabel(vendorId), paymentRef ? `remit ${paymentRef}` : null, line.vendor_ref, line.customer_name, line.po ? `PO ${line.po}` : null].filter(Boolean).join(' · ')
  return {
    preview: {
      lineId: line.id,
      jobId: line.sf_job_id,
      jobNumber: line.sf_job_number,
      customerName: line.matched_customer,
      existingPaymentCount: existingCount,
      safeToApply,
      payment: { amount: line.amount, reference_number: paymentRef ?? '', memo, received_on: toDateOnly(paymentDate), apply_to: applyTo },
      warnings,
    },
  }
}

/** Post the payment to SF and record the result. Idempotent; blocks jobs with
 *  existing payments unless the override is set. */
export async function applyLine(lineId: string, userId: string | null): Promise<{ ok: boolean; error?: string }> {
  const supabase = db()
  const { data: guard } = await supabase.from('remittance_payments').select('apply_status, match_status, sf_job_id').eq('id', lineId).maybeSingle()
  if (!guard) return { ok: false, error: 'Line not found.' }
  if (guard.apply_status === 'applied') return { ok: false, error: 'Already applied.' }
  if (guard.match_status !== 'matched' || !guard.sf_job_id) return { ok: false, error: 'Line is not matched to a job.' }

  const { preview, error } = await previewLine(lineId)
  if (error || !preview) return { ok: false, error: error ?? 'Could not build payment.' }
  if (!preview.safeToApply) return { ok: false, error: `Job has ${preview.existingPaymentCount} existing payment(s); posting is blocked until SF append/replace behavior is verified.` }

  const p = preview.payment
  const newPayment: Record<string, unknown> = { amount: p.amount, reference_number: p.reference_number, memo: p.memo }
  if (p.received_on) newPayment.received_on = p.received_on
  if (p.apply_to) newPayment.apply_to = p.apply_to

  let sfResponse: unknown
  try {
    // Safe under both append and replace semantics: the job has no existing
    // payments (guaranteed above unless the override is deliberately set).
    sfResponse = await sfPut(`/jobs/${encodeURIComponent(preview.jobId)}`, { payments: [newPayment] })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await supabase.from('remittance_payments').update({ apply_status: 'failed', error: msg }).eq('id', lineId).neq('apply_status', 'applied')
    return { ok: false, error: msg }
  }

  const { data: updated } = await supabase.from('remittance_payments').update({
    apply_status: 'applied',
    applied_amount: p.amount,
    sf_payment_response: sfResponse as Record<string, unknown>,
    applied_at: new Date().toISOString(),
    applied_by: userId ?? null,
    error: null,
  }).eq('id', lineId).neq('apply_status', 'applied').select('id, email_id')
  if (!updated || updated.length === 0) return { ok: false, error: 'Line was already applied concurrently.' }
  await refreshEmailStatus(supabase, (updated[0] as { email_id: string }).email_id)
  return { ok: true }
}
