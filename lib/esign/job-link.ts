import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveSfJobMatches } from '@/lib/vendor-orders/sf-match'

// Which SF job a house's form belongs to. vendor_orders.sf_job_id is only set when WE
// created or hand-linked the job; the older Clopay orders (and any booked directly in SF)
// have no stored link — the HD Orders tab finds theirs at display time through the shared
// matcher (PO → name → email → phone). The e-sign flow needs the same answer, but stored:
// the job's start date is what decides when the customer is messaged, and the tech and the
// completed PDF both go to that job. So it is resolved once here and kept on the esign row.
// Only an unambiguous match is kept; a house that matches nothing waits, visibly, on the
// Signatures page (SF job "—") until someone links it in the drawer.

export interface LinkedJob { sfJobId: string; number: string | null; start_date: string | null; method: string }

export async function linkEsignJob(supabase: SupabaseClient, doc: { id: string; order_id: string; sf_job_id: string | null }): Promise<LinkedJob | null> {
  const { data: root } = await supabase.from('vendor_orders').select('id, external_id, customer_po, customer_name, email, phone, sf_job_id').eq('id', doc.order_id).maybeSingle()
  if (!root) return null
  let sfJobId = doc.sf_job_id ?? (root.sf_job_id as string | null) ?? null
  let method = doc.sf_job_id ? 'stored' : root.sf_job_id ? 'order' : ''
  if (!sfJobId) {
    const key = { id: root.id as string, external_id: root.external_id as string | null, customer_po: root.customer_po as string | null, customer_name: root.customer_name as string | null, email: root.email as string | null, phone: root.phone as string | null, sf_job_id: null }
    const m = (await resolveSfJobMatches(supabase, [key])).get(key.id)
    if (m?.sfJobId && !m.ambiguous) { sfJobId = String(m.sfJobId); method = m.method ?? 'match' }
  }
  if (!sfJobId) return null
  const { data: job } = await supabase.from('sf_jobs').select('id, number, start_date').eq('id', sfJobId).maybeSingle()
  if (!job) return null
  if (doc.sf_job_id !== sfJobId) await supabase.from('esign_documents').update({ sf_job_id: sfJobId, updated_at: new Date().toISOString() }).eq('id', doc.id)
  return { sfJobId, number: (job.number as string | null) ?? null, start_date: (job.start_date as string | null) ?? null, method }
}

/** Sweep helper: give every waiting document without a job another look (jobs get booked
 *  in SF after the blank appears in the portal; the mirror catches up hourly). */
export async function linkMissingEsignJobs(supabase: SupabaseClient, limit = 100): Promise<{ looked: number; linked: number }> {
  const out = { looked: 0, linked: 0 }
  const { data } = await supabase.from('esign_documents').select('id, order_id, sf_job_id').is('sf_job_id', null)
    .in('status', ['found', 'prepared', 'sent_customer', 'customer_signed', 'sent_tech', 'tech_signed']).limit(limit)
  for (const d of data ?? []) {
    out.looked++
    if (await linkEsignJob(supabase, d as { id: string; order_id: string; sf_job_id: string | null })) out.linked++
  }
  return out
}
