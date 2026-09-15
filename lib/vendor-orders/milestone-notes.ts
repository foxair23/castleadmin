import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { enqueueNote } from '@/lib/sf-notes/queue'

// Clopay milestones, written onto the Service Fusion job as a note.
//
// Two moments the office wants visible from inside SF rather than only in Castle Admin:
//   • an STS order was received (a forwarded Clopay order email)
//   • the doors reached the Clopay DC and are ready to schedule (the weekly DC report)
//
// Neither can be written at the moment it happens: an STS order is created before any SF job
// exists, and a DC report can name an order whose job is made later. So this runs as a
// catch-up pass instead — every order carrying the milestone AND an SF job gets its note,
// whichever came first. enqueueNote dedupes on the key, so a repeat pass is a no-op and the
// note is written exactly once per order per milestone.

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

const VENDOR = 'clopay_hd'
/** Enough to catch up after an outage; the dedup key stops repeats from costing anything. */
const LIMIT = 200

export interface MilestoneNoteReport { stsReceived: number; atDc: number; errors: string[] }

const fmtDate = (d: string | null): string => {
  if (!d) return 'an earlier date'
  const [y, m, day] = d.slice(0, 10).split('-')
  return `${m}/${day}/${y}`
}

export async function runMilestoneNoteSweep(supabase: SupabaseClient = db()): Promise<MilestoneNoteReport> {
  const out: MilestoneNoteReport = { stsReceived: 0, atDc: 0, errors: [] }

  // 1. STS order received. order_type 'STS' is set only by the forwarded-email ingest.
  const { data: sts } = await supabase.from('vendor_orders')
    .select('id, external_id, customer_po, sf_job_id, first_seen_at')
    .eq('vendor', VENDOR).eq('order_type', 'STS').not('sf_job_id', 'is', null)
    .order('first_seen_at', { ascending: false }).limit(LIMIT)
  for (const o of (sts ?? []) as Array<{ id: string; external_id: string; customer_po: string | null; sf_job_id: string; first_seen_at: string | null }>) {
    const note = `Clopay STS order ${o.external_id}${o.customer_po ? ` (PO ${o.customer_po})` : ''} received ${fmtDate(o.first_seen_at)}.`
    const r = await enqueueNote({ sfJobId: o.sf_job_id, noteText: note, event: 'clopay_sts_received', dedupKey: `sts_received:${o.id}`, refTable: 'vendor_orders', refId: o.id })
    if (r.ok && !r.skipped) out.stsReceived++
    else if (r.error) out.errors.push(`${o.external_id}: ${r.error}`)
  }

  // 2. Doors at the DC, ready to schedule. Keyed on the reserved date, so a later report that
  //    moves the date writes a fresh note rather than being swallowed as a duplicate.
  const { data: dc } = await supabase.from('vendor_orders')
    .select('id, external_id, customer_po, sf_job_id, dc_reserved_at')
    .eq('vendor', VENDOR).not('sf_job_id', 'is', null).not('dc_reserved_at', 'is', null)
    .order('dc_reserved_at', { ascending: false }).limit(LIMIT)
  for (const o of (dc ?? []) as Array<{ id: string; external_id: string; customer_po: string | null; sf_job_id: string; dc_reserved_at: string }>) {
    const day = o.dc_reserved_at.slice(0, 10)
    const note = `Doors for Clopay order ${o.external_id}${o.customer_po ? ` (PO ${o.customer_po})` : ''} are at the DC as of ${fmtDate(day)} — ready to schedule the delivery/install.`
    const r = await enqueueNote({ sfJobId: o.sf_job_id, noteText: note, event: 'clopay_at_dc', dedupKey: `at_dc:${o.id}:${day}`, refTable: 'vendor_orders', refId: o.id })
    if (r.ok && !r.skipped) out.atDc++
    else if (r.error) out.errors.push(`${o.external_id}: ${r.error}`)
  }
  return out
}
