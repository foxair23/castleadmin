'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createSfJobForOrder } from '@/lib/vendor-orders/create-sf-job'
import { setAutopilot } from '@/lib/vendor-orders/autopilot'
import { setNudgeSettings, sendNudgeForOrder } from '@/lib/vendor-orders/schedule-nudge'
import { sendDcRequest, setStsSettings } from '@/lib/clopay-sts/dc-request'
import { uploadAttachmentBytes } from '@/lib/clopay-sts/attachments'
import { CLOPAY_STS_STAGES } from '@/lib/clopay-sts/stages'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { clopayPaymentsByPo } from '@/lib/vendor-orders/payments'
import { enqueueSfJobLines } from '@/lib/vendor-orders/sf-lines-queue'

async function isAllowed(): Promise<boolean> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return false
  const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', user.id).single()
  return !!profile?.is_active && ['admin', 'sales'].includes(profile.role ?? '')
}

/** Create the SF job for one vendor order (manual "Create SF Job" button). */
export async function createSfJobAction(orderId: string): Promise<{ ok: boolean; error?: string; warning?: string }> {
  if (!(await isAllowed())) return { ok: false, error: 'not authorized' }
  const res = await createSfJobForOrder(orderId)
  if (res.ok) { revalidatePath('/admin/vendor-orders'); revalidatePath('/sales/hd-orders') }
  return { ok: res.ok, error: res.error, warning: res.warning }
}

/** Manually send the schedule reminder (email + SMS) for one order — HD Orders
 *  "Send reminder" button. Admin + sales (same as Create SF Job). */
export async function sendNudgeNowAction(orderId: string): Promise<{ ok: boolean; error?: string; warning?: string; channels?: string[] }> {
  if (!(await isAllowed())) return { ok: false, error: 'not authorized' }
  const res = await sendNudgeForOrder(orderId)
  if (res.ok) { revalidatePath('/admin/vendor-orders'); revalidatePath('/sales/hd-orders') }
  return res
}

/** One order's captured `raw` detail (Clopay Summary/Documents/Notes) for the HD Orders
 *  drawer. Fetched on demand when a drawer opens — the list payload no longer carries
 *  `raw` (at 5–30KB × 1000 rows it dominated page load). Admin + sales. */
export async function getOrderDetailAction(orderId: string): Promise<{ ok: boolean; raw?: unknown; doors?: unknown[]; error?: string }> {
  if (!(await isAllowed())) return { ok: false, error: 'not authorized' }
  const db = stsDb()
  // A multi-door job is several Clopay orders (one per door) grouped under one primary —
  // fetch the whole group so the drawer can show every door's line items, which together
  // are what the single SF job is worth.
  const [{ data }, { data: kids }] = await Promise.all([
    db.from('vendor_orders').select('raw, external_id, customer_po, derived_total_fee, record_source, status').eq('id', orderId).maybeSingle(),
    db.from('vendor_orders')
      .select('id, external_id, customer_po, derived_total_fee, record_source, status')
      .eq('parent_order_id', orderId)
      .order('external_id', { ascending: true }),
  ])
  if (!data) return { ok: false, error: 'order not found' }

  const children = (kids ?? []) as Array<{ id: string; external_id: string; customer_po: string | null; derived_total_fee: number | null; record_source: string | null; status: string | null }>
  const ids = [orderId, ...children.map(c => c.id)]
  const { data: lines } = await db
    .from('vendor_order_line_items')
    .select('order_id, source_order_number, line_no, quantity, item_number, description, line_fee, unit_fee, schedule_rate, rate_variance')
    .in('order_id', ids)
    .eq('is_current', true)
    .order('sort_order', { ascending: true })

  const byOrder = new Map<string, unknown[]>()
  for (const l of (lines ?? []) as Array<Record<string, unknown>>) {
    const k = String(l.order_id)
    const arr = byOrder.get(k) ?? []
    arr.push({ line_no: l.line_no, quantity: l.quantity, item_number: l.item_number, description: l.description, line_fee: l.line_fee,
      unit_fee: l.unit_fee, schedule_rate: l.schedule_rate, rate_variance: l.rate_variance })
    byOrder.set(k, arr)
  }

  // What has been paid against each door's own PO, so a part-paid job shows WHICH door is
  // still outstanding rather than just a total that doesn't reach the fee.
  const { byPo } = await clopayPaymentsByPo(db, [data.customer_po ?? '', ...children.map(c => c.customer_po ?? '')])
  const paidFor = (po: string | null) => byPo.get((po ?? '').trim()) ?? null

  // A door's fee is the sum of ITS OWN current line items.
  //
  // derived_total_fee cannot be used here: it means two different things depending on the row
  // — a child's is its own door, but the PRIMARY's is the whole group's roll-up
  // (rollUpGroupTotal in lib/vendor-orders/ipo-ingest.ts). Reading it for the primary made the
  // first door claim the entire job's fee, so a door paid in full showed as short by the other
  // doors' fees. Summing line items is self-consistent by construction: the doors always add
  // up to the Job Total, and neither branch has to know which rows carry a roll-up.
  const ownFee = (id: string): number | null => {
    const items = (byOrder.get(id) ?? []) as Array<{ line_fee: number | null }>
    return items.length ? items.reduce((a, l) => a + Number(l.line_fee ?? 0), 0) : null
  }
  // No line items yet (no IPO parsed): a child's stored total is already its own door, while
  // the primary's has to have the children backed out of it.
  const childTotal = children.reduce((a, c) => a + Number(c.derived_total_fee ?? 0), 0)
  const primaryFallback = Math.max(0, Number(data.derived_total_fee ?? 0) - childTotal)

  // The primary door first, then the rest — the order the office reads them in.
  const doors = [
    { orderId, external_id: data.external_id, customer_po: data.customer_po,
      total_fee: ownFee(orderId) ?? (data.derived_total_fee == null ? null : primaryFallback),
      record_source: data.record_source, status: data.status,
      payment_received: paidFor(data.customer_po),
      items: byOrder.get(orderId) ?? [] },
    ...children.map(c => ({
      orderId: c.id, external_id: c.external_id, customer_po: c.customer_po,
      total_fee: ownFee(c.id) ?? c.derived_total_fee,
      record_source: c.record_source, status: c.status,
      payment_received: paidFor(c.customer_po),
      items: byOrder.get(c.id) ?? [],
    })),
  ].filter(d => d.items.length > 0 || d.orderId === orderId)

  return { ok: true, raw: data.raw ?? {}, doors }
}

/** Queue this order's IPO line items for its existing SF job — the manual counterpart to the
 *  automatic sweep, for a job someone wants filled in now.
 *
 *  Queued, not posted: Service Fusion's API cannot modify an existing job (PUT /jobs → 405),
 *  so the extension posts it through SF's web session on its next run — the same arrangement
 *  the remittance flow uses. Refuses outright when the job already carries line items. */
export async function addIpoLinesToSfJobAction(orderId: string): Promise<{ ok: boolean; status: string; added?: number; existing?: number; note?: string; error?: string }> {
  if (!(await isAllowed())) return { ok: false, status: 'error', error: 'not authorized' }
  const r = await enqueueSfJobLines(orderId)
  if (r.ok) { revalidatePath('/admin/vendor-orders'); revalidatePath('/sales/hd-orders') }
  return { ok: r.ok, status: r.status, added: r.lines, existing: r.existing, note: r.note, error: r.error }
}

/** Toggle a vendor's autopilot (admin only). vendor: 'genie_thd' | 'clopay_hd'. */
export async function setAutopilotAction(vendor: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  if (!['genie_thd', 'clopay_hd'].includes(vendor)) return { ok: false, error: 'invalid vendor' }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'not authorized' }
  const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') return { ok: false, error: 'admin only' }
  await setAutopilot(vendor, enabled, user.id)
  revalidatePath('/admin/vendor-orders'); revalidatePath('/sales/hd-orders')
  return { ok: true }
}

/** Toggle / configure the Genie schedule nudge (admin only). */
export async function setNudgeSettingsAction(enabled: boolean, scheduleUrl: string | null): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'not authorized' }
  const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') return { ok: false, error: 'admin only' }
  await setNudgeSettings('genie_thd', enabled, scheduleUrl, user.id)
  revalidatePath('/admin/vendor-orders'); revalidatePath('/sales/hd-orders')
  return { ok: true }
}

// ── Clopay STS ─────────────────────────────────────────────────────────────

function revalidateSts() {
  revalidatePath('/admin/vendor-orders/clopay-sts')
  revalidatePath('/sales/hd-orders/clopay-sts')
  revalidatePath('/admin/action-items')
}

function stsDb() {
  return createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

/** Set an STS order's pipeline status (admin + sales). */
export async function setStsStatusAction(orderId: string, stage: string): Promise<{ ok: boolean; error?: string }> {
  if (!(await isAllowed())) return { ok: false, error: 'not authorized' }
  if (!CLOPAY_STS_STAGES.includes(stage as (typeof CLOPAY_STS_STAGES)[number])) return { ok: false, error: 'invalid status' }
  const db = stsDb()
  const { data: cur } = await db.from('vendor_orders').select('status').eq('id', orderId).eq('vendor', 'clopay_sts').maybeSingle()
  if (!cur) return { ok: false, error: 'order not found' }
  const nowIso = new Date().toISOString()
  await db.from('vendor_orders').update({ status: stage, updated_at: nowIso }).eq('id', orderId)
  await db.from('vendor_order_events').insert({ order_id: orderId, event_type: 'status_change', from_value: cur.status, to_value: stage })
  revalidateSts()
  return { ok: true }
}

/** Manually email the DC for one order's details (HD Orders "Request details"). */
export async function sendDcRequestAction(orderId: string): Promise<{ ok: boolean; error?: string }> {
  if (!(await isAllowed())) return { ok: false, error: 'not authorized' }
  const res = await sendDcRequest(orderId)
  if (res.ok) revalidateSts()
  return res
}

/** Upload a PDF/image attachment to an STS order (manual upload). */
export async function uploadStsAttachmentAction(orderId: string, formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'not authorized' }
  const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || !['admin', 'sales'].includes(profile.role ?? '')) return { ok: false, error: 'not authorized' }

  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: 'no file' }
  if (file.size > 26214400) return { ok: false, error: 'file too large (max 25 MB)' }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const res = await uploadAttachmentBytes(orderId, file.name, file.type || 'application/octet-stream', bytes, 'manual', user.id)
  if (!res.ok) return { ok: false, error: res.error }
  revalidateSts()
  return { ok: true }
}

/** Toggle / configure the Clopay STS auto-request to the DC (admin only). */
export async function setStsSettingsAction(enabled: boolean, dcEmail: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'not authorized' }
  const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') return { ok: false, error: 'admin only' }
  await setStsSettings(enabled, dcEmail.trim(), user.id)
  revalidateSts()
  return { ok: true }
}
