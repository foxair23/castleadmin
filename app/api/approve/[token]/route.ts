import { NextRequest, NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { renderItemsTableHtml, renderDescriptionHtml, type ApprovalLineItem } from '@/lib/approvals/acceptance'
import { renderApprovalConfirmationEmail } from '@/lib/notifications/templates/approval-email'
import { sendEmail } from '@/lib/notifications/resend'

const COMPLIANCE_BCC = 'john@castlegaragedoors.com'

function db() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

// POST — the CUSTOMER approves via the tokenized link (no login). The unguessable
// token authorizes this one approval. Body: { typed_name, agree }.
// First-approval-wins / single-use: the stamp only lands while status='pending'.
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  let body: { typed_name?: string; agree?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const { typed_name, agree } = body
  if (agree !== true) return NextResponse.json({ error: 'You must check the approval box.' }, { status: 400 })
  if (!typed_name || !typed_name.trim()) return NextResponse.json({ error: 'Type your full name to approve.' }, { status: 400 })

  const supabase = db()
  const { data: approval } = await supabase
    .from('job_approvals')
    .select('id, status, source_id, customer_name, customer_email, job_description, line_items_snapshot, amount_total, legal_version, terms_fingerprint')
    .eq('token', token)
    .maybeSingle()
  if (!approval) return NextResponse.json({ error: 'This approval link is not valid.' }, { status: 404 })
  if (approval.status !== 'pending') {
    return NextResponse.json({ error: 'This request has already been completed.' }, { status: 409 })
  }

  const approvedName = typed_name.trim()
  const approvedAtIso = new Date().toISOString()
  const ip = (req.headers.get('x-forwarded-for')?.split(',')[0].trim())
    || req.headers.get('x-real-ip')
    || null
  const userAgent = req.headers.get('user-agent') || null

  // Conditional update: only stamps while still pending, so a double-submit or a
  // shared link can't record two approvals (single-use token).
  const { data: stamped, error: updErr } = await supabase
    .from('job_approvals')
    .update({
      status: 'approved',
      approved_at: approvedAtIso,
      approved_name: approvedName,
      ip,
      user_agent: userAgent,
    })
    .eq('id', approval.id)
    .eq('status', 'pending')
    .select('id')
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })
  if (!stamped || stamped.length === 0) {
    return NextResponse.json({ error: 'This request has already been completed.' }, { status: 409 })
  }

  // Confirmation email to the customer (record of what was approved), BCC'd to
  // compliance so it doubles as the staff notification. Best-effort — the
  // approval is already persisted, so a mail hiccup must not fail the request.
  try {
    const email = approval.customer_email as string | null
    if (email) {
      const items = (approval.line_items_snapshot ?? []) as ApprovalLineItem[]
      const total = Number(approval.amount_total ?? 0)
      const approvedAtHuman = new Date(approvedAtIso).toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles', dateStyle: 'full', timeStyle: 'long',
      })
      const { html, text } = renderApprovalConfirmationEmail({
        customerName: (approval.customer_name as string | null) ?? null,
        jobNumber: null,
        descriptionHtml: renderDescriptionHtml(approval.job_description as string | null),
        itemsHtml: renderItemsTableHtml(items, total),
        approvedName,
        approvedAt: approvedAtHuman,
        ip,
        userAgent,
        fingerprint: (approval.terms_fingerprint as string | null) ?? null,
        legalVersion: (approval.legal_version as string | null) ?? null,
      })
      await sendEmail({ to: email, subject: 'Your approval is recorded', html, text, bcc: COMPLIANCE_BCC })
    }
  } catch (e) {
    console.error('[approvals] confirmation email failed:', e)
  }

  return NextResponse.json({ ok: true })
}
