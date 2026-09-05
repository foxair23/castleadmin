import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { enqueueSfJobLines } from './sf-lines-queue'

// Sweep: queue IPO line items for jobs that already exist.
//
// Creating a job attaches its lines in the POST, but that rarely fires in practice: the order
// is crawled and autopilot books the job within 15 minutes, while the IPO document is only
// captured when the extension's doc sync runs and parsed after that. So the usual sequence is
// a job created empty and an IPO that turns up later.
//
// Service Fusion's API cannot fill that gap — PUT /jobs is 405 and no update endpoint exists.
// The work is queued instead, and the extension posts it through SF's web session, exactly as
// the remittance flow does. enqueueSfJobLines holds the safety rule: a job that already
// carries line items is skipped, never competed with.

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
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
    .is('sf_lines_status', null)
    .limit(limit)
  if (error) { console.error('[sf-job-lines] sweep:', error.message); return out }

  for (const o of (data ?? []) as Array<{ id: string }>) {
    out.considered++
    const r = await enqueueSfJobLines(o.id)
    if (r.status === 'queued') out.added++
    else if (!r.ok) out.errors++
    else {
      out.skipped++
      // enqueueSfJobLines already stamps skips, so the sweep never re-reads them from SF.
    }
  }
  return out
}
