import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// The HD SOF sub-statuses on the Service Fusion job — the handshake between the office and
// this app for the Home Depot sign-off form:
//
//   HD SOF Needed    the OFFICE sets it. The form goes to the customer the morning of the
//                    job's scheduled date. An explicit instruction: it overrides whatever
//                    the job's own status ("Waiting on Clopay" and the like) might suggest.
//   HD SOF Sent      WE set it, once the customer has been sent the form.
//   HD SOF Complete  WE set it, once both parties have signed and the finished document is
//                    filed on the job.
//
// SF's API cannot write a sub-status, so the Chrome extension does it through the web
// session and reports back. The columns on esign_documents are that queue; our own document
// record — not the sub-status — remains the record of what we actually sent.

export const SOF_NEEDED = 'HD SOF Needed'
export const SOF_SENT = 'HD SOF Sent'
export const SOF_COMPLETE = 'HD SOF Complete'

export type SofStage = 'needed' | 'sent' | 'complete'

/** Matched loosely on purpose: a stray double space typed in SF settings should not mean
 *  a customer never gets their form. */
const key = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
const BY_KEY = new Map<string, SofStage>([[key(SOF_NEEDED), 'needed'], [key(SOF_SENT), 'sent'], [key(SOF_COMPLETE), 'complete']])

/** Which HD SOF stage a job's sub-status is at, or null for anything else (including none). */
export function sofStageOf(subStatus: string | null | undefined): SofStage | null {
  return BY_KEY.get(key(subStatus)) ?? null
}

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

/** Ask the extension to set this document's job to `target`.
 *
 *  `sf_sub_status_set_at` is cleared here, and only the callback sets it again. That is what
 *  keeps a re-send honest: while a write is in flight the document has no confirmation, so
 *  the sweep cannot read "still Needed" as the office asking for the form a second time. */
export async function enqueueSubStatus(supabase: SupabaseClient, docId: string, target: string): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await supabase.from('esign_documents').update({
    sf_sub_status_target: target, sf_sub_status_status: 'queued', sf_sub_status_queued_at: now,
    sf_sub_status_set_at: null, sf_sub_status_note: null, updated_at: now,
  }).eq('id', docId)
  if (error) console.error('[esign sub-status] enqueue:', error.message)
}

export interface SubStatusQueueItem { id: string; jobNumber: string; subStatus: string }

/** What the extension should set next. Documents whose job is not in the mirror yet are left
 *  queued: SF's global search needs the job NUMBER to find the page, and the id alone cannot. */
export async function getEsignSubStatusQueue(limit = 10): Promise<{ items: SubStatusQueueItem[] }> {
  const supabase = db()
  const { data, error } = await supabase.from('esign_documents')
    .select('id, sf_job_id, sf_sub_status_target')
    .eq('sf_sub_status_status', 'queued')
    .not('sf_job_id', 'is', null).not('sf_sub_status_target', 'is', null)
    .order('sf_sub_status_queued_at', { ascending: true }).limit(limit)
  if (error) { console.error('[esign sub-status] queue read:', error.message); return { items: [] } }
  const rows = (data ?? []) as Array<{ id: string; sf_job_id: string; sf_sub_status_target: string }>
  if (!rows.length) return { items: [] }
  const { data: jobs } = await supabase.from('sf_jobs').select('id, number').in('id', [...new Set(rows.map(r => r.sf_job_id))])
  const numberById = new Map(((jobs ?? []) as Array<{ id: string | number; number: string | null }>).map(j => [String(j.id), j.number]))
  const items: SubStatusQueueItem[] = []
  for (const r of rows) {
    const jobNumber = numberById.get(String(r.sf_job_id))
    if (!jobNumber) continue
    items.push({ id: r.id, jobNumber, subStatus: r.sf_sub_status_target })
  }
  return { items }
}

/** The extension reporting one write. `subStatus` is what SF echoed back. */
export async function recordSubStatusResult(id: string, result: { ok?: boolean; error?: string; subStatus?: string }): Promise<{ ok: boolean; error?: string }> {
  const supabase = db()
  const now = new Date().toISOString()
  const patch = result.ok
    ? { sf_sub_status_status: 'done', sf_sub_status_set_at: now, sf_sub_status_note: `SF now reads "${result.subStatus ?? 'set'}"`, updated_at: now }
    : { sf_sub_status_status: 'failed', sf_sub_status_note: (result.error ?? 'unknown error').slice(0, 500), updated_at: now }
  const { error } = await supabase.from('esign_documents').update(patch).eq('id', id)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
