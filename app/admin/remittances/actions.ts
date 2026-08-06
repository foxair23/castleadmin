'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { rematchPending, reparseEmails, aiReviewPending, assignLineJob, setVendorAutopilot } from '@/lib/remittance/engine'
import { previewLine, setLineExcluded, type PaymentPreview } from '@/lib/remittance/apply'
import { setApproved } from '@/lib/remittance/apply-queue'

/** Returns the admin's user id, or null if the caller isn't an admin. */
async function adminUserId(): Promise<string | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  return profile?.role === 'admin' ? user.id : null
}
const isAdmin = async () => (await adminUserId()) !== null

// Re-run matching on all not-yet-applied remittance lines with the current
// matcher. Admin-only; applied lines are never touched.
export async function rematchAllAction() {
  if (!(await isAdmin())) return
  await rematchPending()
  revalidatePath('/admin/remittances')
}

// AI review of residual (no_match/ambiguous) lines — advisory suggestions only.
export async function aiReviewAction() {
  if (!(await isAdmin())) return
  await aiReviewPending()
  revalidatePath('/admin/remittances')
}

// Re-parse retained raw emails to refresh header fields (fixes a null reference
// from an earlier parser build).
export async function reparseAction() {
  if (!(await isAdmin())) return
  await reparseEmails()
  revalidatePath('/admin/remittances')
}

// Manually allocate a remittance line to a chosen SF job (suggestion or typed
// job number). Returns an error string the UI can show.
export async function assignLineJobAction(lineId: string, opts: { jobId?: string; jobNumber?: string }): Promise<{ ok?: boolean; error?: string }> {
  if (!(await isAdmin())) return { error: 'Not authorized.' }
  const res = await assignLineJob(lineId, opts)
  if (res.ok) revalidatePath('/admin/remittances')
  return res.ok ? { ok: true } : { error: res.error }
}

// Build the exact SF payload for a line WITHOUT posting (dry run).
export async function previewLineAction(lineId: string): Promise<{ preview?: PaymentPreview; error?: string }> {
  if (!(await isAdmin())) return { error: 'Not authorized.' }
  return previewLine(lineId)
}

// Approve a matched line for posting. The Chrome extension posts approved lines
// into Service Fusion (SF has no payment API) and calls back to mark them applied.
export async function applyLineAction(lineId: string): Promise<{ ok?: boolean; error?: string }> {
  if (!(await isAdmin())) return { error: 'Not authorized.' }
  const res = await setApproved(lineId, true)
  if (res.ok) revalidatePath('/admin/remittances')
  return res.ok ? { ok: true } : { error: res.error }
}

// Un-approve (pull back from the extension queue).
export async function unapproveLineAction(lineId: string): Promise<{ ok?: boolean; error?: string }> {
  if (!(await isAdmin())) return { error: 'Not authorized.' }
  const res = await setApproved(lineId, false)
  if (res.ok) revalidatePath('/admin/remittances')
  return res.ok ? { ok: true } : { error: res.error }
}

// Exclude / un-exclude a line from applying.
export async function setLineExcludedAction(lineId: string, excluded: boolean): Promise<{ ok?: boolean; error?: string }> {
  if (!(await isAdmin())) return { error: 'Not authorized.' }
  const res = await setLineExcluded(lineId, excluded)
  if (res.ok) revalidatePath('/admin/remittances')
  return res.ok ? { ok: true } : { error: res.error }
}

// Turn a vendor's autopilot on/off.
export async function setAutopilotAction(vendorId: string, on: boolean): Promise<void> {
  if (!(await isAdmin())) return
  await setVendorAutopilot(vendorId, on)
  revalidatePath('/admin/remittances')
}
