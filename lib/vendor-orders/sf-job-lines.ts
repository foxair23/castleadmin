import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { sfGet, sfPut } from '@/lib/crm/service-fusion'
import { loadIpoLines, toSfServices, type SfServiceLine } from './ipo-services'

// Put a Clopay order's IPO line items onto its EXISTING Service Fusion job.
//
// Creating a job attaches its lines in the POST, but that rarely fires in practice: the order
// is crawled and autopilot books the job within 15 minutes, while the IPO document is only
// captured when the extension's doc sync runs and parsed after that. So the usual sequence is
// a job created empty and an IPO that turns up later — and without this, nothing ever goes
// back to fill it in.
//
// THE DANGEROUS PART: the SF spec describes `services` as "the job's services list that will
// be set" — a REPLACE, not an append. Sending only the IPO lines to a job that already has
// hand-entered services would destroy them. So a write only happens when the job carries NO
// services. Anything else is reported, never overwritten.

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export interface SfLineSyncResult {
  ok: boolean
  status: 'added' | 'already_has_lines' | 'nothing_to_add' | 'no_job' | 'error'
  added?: number
  existing?: number
  /** What is already on the job, when we declined to touch it. */
  existingNames?: string[]
  /** What we would have added, so a human can see the merge before deciding. */
  wouldAdd?: Array<{ code: string; quantity: number; rate: number }>
  jobId?: string
  note?: string
  error?: string
}

/** The order that owns the SF job — a group's primary — plus every door under it. */
async function resolveGroup(supabase: SupabaseClient, orderId: string) {
  const { data: self } = await supabase
    .from('vendor_orders')
    .select('id, vendor, external_id, parent_order_id, sf_job_id, customer_po')
    .eq('id', orderId).maybeSingle()
  if (!self) return null
  const rootId = (self.parent_order_id as string | null) ?? (self.id as string)
  const { data: rows } = await supabase
    .from('vendor_orders')
    .select('id, external_id, customer_po, sf_job_id')
    .or(`id.eq.${rootId},parent_order_id.eq.${rootId}`)
    .order('external_id', { ascending: true })
  const doors = (rows ?? []) as Array<{ id: string; external_id: string; customer_po: string | null; sf_job_id: string | null }>
  const primary = doors.find(d => d.id === rootId) ?? doors[0]
  // Any door may carry the job id — creation stamps the whole group.
  const jobId = doors.map(d => d.sf_job_id).find(Boolean) ?? null
  return { primary, doors, jobId }
}

/** Services already on the job, read LIVE. The sf_job_items mirror is synced periodically, so
 *  deciding from it risks acting on a list that has since changed. */
async function liveServices(jobId: string): Promise<Array<Record<string, unknown>>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j = (await sfGet(`/jobs/${encodeURIComponent(jobId)}`, { expand: 'services' })) as any
  const job = j?.items?.[0] ?? j
  return Array.isArray(job?.services) ? job.services : []
}

const codeOf = (s: Record<string, unknown>) =>
  String(s.service ?? s.name ?? '').trim().toUpperCase()

/** Attach one order's IPO lines to its existing SF job.
 *  `preview` reports what would happen without writing anything. */
export async function syncIpoLinesToSfJob(orderId: string, opts: { preview?: boolean } = {}): Promise<SfLineSyncResult> {
  const supabase = db()
  try {
    const group = await resolveGroup(supabase, orderId)
    if (!group) return { ok: false, status: 'error', error: 'order not found' }
    if (!group.jobId) return { ok: false, status: 'no_job', note: 'no SF job on this order yet' }

    const lines = await loadIpoLines(supabase, group.doors.map(d => d.id))
    const services = toSfServices(lines, new Map(group.doors.map(d => [d.id, d.customer_po])))
    if (!services.length) {
      return { ok: true, status: 'nothing_to_add', jobId: group.jobId, added: 0, note: 'no IPO line items with revenue' }
    }

    const existing = await liveServices(group.jobId)
    const existingCodes = new Set(existing.map(codeOf).filter(Boolean))
    const toAdd = services.filter(s => !existingCodes.has(s.service.trim().toUpperCase()))
    const wouldAdd = toAdd.map(s => ({ code: s.service, quantity: s.multiplier, rate: s.rate }))

    if (existing.length > 0) {
      // Never overwrite hand-entered work. `services` is a REPLACE, and the read shape
      // (typ.JobService) differs from the write shape (typ.JobServiceBody) — item_index,
      // service_list_id and service_rate_id have no write equivalent — so re-sending existing
      // lines may not reproduce them faithfully. Until that round-trip is proven on a
      // throwaway job, report and stop.
      return {
        ok: true, status: 'already_has_lines', jobId: group.jobId,
        existing: existing.length, added: 0,
        existingNames: existing.map(s => String(s.name ?? s.service ?? '')).filter(Boolean),
        wouldAdd,
        note: `job already has ${existing.length} line item(s) — not overwriting`,
      }
    }

    if (opts.preview) {
      return { ok: true, status: 'added', jobId: group.jobId, added: 0, existing: 0, wouldAdd, note: 'preview only' }
    }

    await sfPut(`/jobs/${encodeURIComponent(group.jobId)}`, { services: toAdd as SfServiceLine[] })
    const note = `added ${toAdd.length} line item(s)`
    await supabase.from('vendor_orders')
      .update({ sf_lines_synced_at: new Date().toISOString(), sf_lines_sync_note: note })
      .eq('id', group.primary.id)
    return { ok: true, status: 'added', jobId: group.jobId, added: toAdd.length, existing: 0, wouldAdd, note }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    console.error(`[sf-job-lines] ${orderId}: ${error}`)
    return { ok: false, status: 'error', error }
  }
}

export interface SfLineSweepResult { considered: number; added: number; skipped: number; errors: number }

/** Sweep: attach lines to jobs whose IPO arrived after the job was created.
 *  Only group PRIMARIES are considered — one job covers the whole group. */
export async function syncPendingSfJobLines(limit = 25): Promise<SfLineSweepResult> {
  const supabase = db()
  const out: SfLineSweepResult = { considered: 0, added: 0, skipped: 0, errors: 0 }

  const { data, error } = await supabase
    .from('vendor_orders')
    .select('id')
    .eq('vendor', 'clopay_hd')
    .not('sf_job_id', 'is', null)
    .is('parent_order_id', null)
    .is('sf_lines_synced_at', null)
    .limit(limit)
  if (error) { console.error('[sf-job-lines] sweep:', error.message); return out }

  for (const o of (data ?? []) as Array<{ id: string }>) {
    out.considered++
    const r = await syncIpoLinesToSfJob(o.id)
    if (r.status === 'added' && (r.added ?? 0) > 0) out.added++
    else if (!r.ok) out.errors++
    else {
      out.skipped++
      // Stamp the skips too, or every sweep re-reads the same jobs from SF forever.
      await supabase.from('vendor_orders')
        .update({ sf_lines_synced_at: new Date().toISOString(), sf_lines_sync_note: r.note ?? r.status })
        .eq('id', o.id)
    }
  }
  return out
}
