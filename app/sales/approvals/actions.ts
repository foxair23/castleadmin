'use server'

import { createServiceClient } from '@/lib/supabase/server'
import { appUrl } from '@/lib/config/domains'
import { requireAdminOrSales } from '@/lib/approvals/auth'
import { loadJobApprovalContext, type JobApprovalContext } from '@/lib/approvals/contact'
import {
  approvalFingerprint,
  generateApprovalToken,
  itemsTotal,
  renderItemsTableHtml,
  renderDescriptionHtml,
  fmtCurrency,
} from '@/lib/approvals/acceptance'
import { LEGAL_VERSION } from '@/lib/approvals/legal'
import { renderApprovalEmail } from '@/lib/notifications/templates/approval-email'
import { sendEmail } from '@/lib/notifications/resend'
import { sendSms, toE164 } from '@/lib/dialpad/client'
import { ensureShortLink } from '@/lib/short-links'
import { syncSingleJob, runIncrementalSyncForEntity } from '@/lib/sf-mirror/sync-engine'

function appBase(): string {
  return appUrl()
}

export type LookupResult =
  | { ok: true; ctx: JobApprovalContext }
  | { ok: false; error: string }

// Resolve a job (by job number, else by SF id) into the send-form preview:
// line items + resolved customer contact. Read-only.
export async function lookupJob(query: string): Promise<LookupResult> {
  const auth = await requireAdminOrSales()
  if (!auth) return { ok: false, error: 'Unauthorized' }

  const q = query.trim()
  if (!q) return { ok: false, error: 'Enter a job number.' }

  const db = await createServiceClient()
  const { data: byNumber } = await db
    .from('sf_jobs')
    .select('id')
    .eq('number', q)
    .eq('is_deleted', false)
    .limit(1)
  const resolvedId = byNumber?.[0]?.id ?? null
  const jobId = resolvedId ?? q

  // Pull the latest for this job (line items) + its customer (email/phone) live
  // from Service Fusion so the preview is complete, since the mirror's line-item
  // and contact tables aren't always populated. Best-effort — if SF is
  // unavailable we still show whatever the mirror already has. Only auto-pull
  // when we resolved a real internal id from the number, so a typed value can't
  // coincidentally fetch an unrelated job by its internal id.
  if (resolvedId) await syncSingleJob(resolvedId)

  const ctx = await loadJobApprovalContext(db, jobId)
  if (!ctx) return { ok: false, error: `Job "${q}" not found in the mirror.` }
  return { ok: true, ctx }
}

// Pull the latest data for ONE job from Service Fusion right now (line items,
// customer, totals), then re-load the preview. Use after fixing the job in SF so
// the operator doesn't have to wait for the hourly sync.
export async function refreshJob(jobId: string): Promise<LookupResult> {
  const auth = await requireAdminOrSales()
  if (!auth) return { ok: false, error: 'Unauthorized' }

  const res = await syncSingleJob(jobId)
  if (!res.ok) return { ok: false, error: res.error ?? 'Refresh failed.' }

  const db = await createServiceClient()
  const ctx = await loadJobApprovalContext(db, jobId)
  if (!ctx) return { ok: false, error: 'Job not found after refresh.' }
  return { ok: true, ctx }
}

export type SyncResult = { ok: true; upserted: number } | { ok: false; error: string }

// Pull recently created/updated jobs from Service Fusion into the mirror, so a
// job just created in SF can be looked up here without waiting for the hourly
// sync. Same incremental jobs pass the hourly cron runs; soft-capped so it fits
// the request budget (newest jobs come first, so a capped run still gets them).
export async function syncJobsMirror(): Promise<SyncResult> {
  const auth = await requireAdminOrSales()
  if (!auth) return { ok: false, error: 'Unauthorized' }
  try {
    const upserted = await runIncrementalSyncForEntity('jobs', Date.now() + 50_000)
    return { ok: true, upserted }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Sync failed' }
  }
}

export type SendResult =
  | { ok: true; approveUrl: string; sent: string[]; warning?: string }
  | { ok: false; error: string }

// Build the immutable snapshot, insert a pending job_approvals row with a random
// token, then send the tokenized approval link via email and/or SMS to the
// operator-confirmed recipient(s).
export async function sendApproval(input: {
  jobId: string
  channel: 'email' | 'sms' | 'both'
  email: string | null
  phone: string | null
  customerName: string | null
}): Promise<SendResult> {
  const auth = await requireAdminOrSales()
  if (!auth) return { ok: false, error: 'Unauthorized' }

  const db = await createServiceClient()
  const ctx = await loadJobApprovalContext(db, input.jobId)
  if (!ctx) return { ok: false, error: 'Job not found.' }
  if (ctx.lineItems.length === 0) {
    return { ok: false, error: 'This job has no line items to approve yet. Sync the job in Service Fusion first.' }
  }

  const wantEmail = input.channel === 'email' || input.channel === 'both'
  const wantSms = input.channel === 'sms' || input.channel === 'both'
  const email = (input.email ?? '').trim() || null
  const phoneE164 = toE164(input.phone)
  if (wantEmail && !email) return { ok: false, error: 'No email address to send to.' }
  if (wantSms && !phoneE164) return { ok: false, error: 'No valid mobile number to text.' }

  const items = ctx.lineItems
  // The customer approves the JOB total (matches SF/invoice, incl. any tax/fees);
  // fall back to the line-item sum only if the job has no total.
  const total = ctx.jobTotal ?? itemsTotal(items)
  const fingerprint = approvalFingerprint(items, total)
  const token = generateApprovalToken()
  const customerName = (input.customerName ?? ctx.contactName ?? ctx.customerName) || null
  const intendedChannels = [...(wantEmail ? ['email'] : []), ...(wantSms ? ['sms'] : [])]

  const { error: insErr } = await db.from('job_approvals').insert({
    source_type: 'job',
    source_id: ctx.jobId,
    token,
    customer_name: customerName,
    customer_email: email,
    customer_phone: phoneE164,
    job_description: ctx.jobDescription,
    line_items_snapshot: items,
    amount_total: total,
    legal_version: LEGAL_VERSION,
    terms_fingerprint: fingerprint,
    status: 'pending',
    sent_channels: intendedChannels,
    sent_at: new Date().toISOString(),
    created_by: auth.userId,
  })
  if (insErr) return { ok: false, error: insErr.message }

  const approveUrl = `${appBase()}/approve/${token}`
  const sent: string[] = []
  const errors: string[] = []

  if (wantEmail && email) {
    try {
      const itemsHtml = renderItemsTableHtml(items, total)
      const { html, text } = renderApprovalEmail({
        customerName,
        jobNumber: ctx.jobNumber,
        descriptionHtml: renderDescriptionHtml(ctx.jobDescription),
        descriptionText: ctx.jobDescription,
        itemsHtml,
        approveUrl,
      })
      await sendEmail({
        to: email,
        subject: `Please approve your work${ctx.jobNumber ? ` — Job ${ctx.jobNumber}` : ''}`,
        html,
        text,
      })
      sent.push('email')
    } catch (e) {
      errors.push(`Email: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (wantSms && phoneE164) {
    try {
      const shortUrl = await ensureShortLink(approveUrl)
      const msg = `Castle Garage Doors: please review & approve your quote${ctx.jobNumber ? ` (Job ${ctx.jobNumber})` : ''} for ${fmtCurrency(total)}: ${shortUrl}`
      const res = await sendSms(phoneE164, msg)
      if (res.ok) sent.push('sms')
      else errors.push(`SMS: ${res.error ?? 'failed'}`)
    } catch (e) {
      errors.push(`SMS: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Record what actually went out (may differ from intent if a channel errored).
  await db.from('job_approvals').update({ sent_channels: sent }).eq('token', token)

  if (sent.length === 0) {
    return { ok: false, error: `Failed to send. ${errors.join('; ')}` }
  }
  return { ok: true, approveUrl, sent, warning: errors.length ? errors.join('; ') : undefined }
}
