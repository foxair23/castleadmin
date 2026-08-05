import type { SupabaseClient } from '@supabase/supabase-js'
import type { RemittanceLine, RemittanceVendor } from './parse'

// Match a remittance line to an SF job by PO number. A job may carry several POs
// separated by ; or / — we check membership, not equality. Clopay lines also
// carry a customer name, which we use to validate/disambiguate the PO match.

export type MatchStatus = 'matched' | 'ambiguous' | 'no_match' | 'amount_mismatch'

export interface LineMatch {
  match_status: MatchStatus
  sf_job_id: string | null
  sf_job_number: string | null
  matched_customer: string | null
  open_amount: number | null
  match_confidence: number | null
  candidates: Array<{ id: string; number: string | null; customer_name: string | null; po_number: string | null }> | null
}

interface JobRow { id: string; number: string | null; customer_name: string | null; po_number: string | null; due_total: number | null }

const splitPos = (raw: string | null): string[] =>
  (raw ?? '').split(/[;/,]/).map(s => s.trim()).filter(Boolean)

function normName(s: string | null | undefined): string {
  return (s ?? '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
}
/** Token-set overlap 0..1 between two names ("MENDOZA, ASIA" vs "Asia Mendoza"). */
function nameScore(a: string | null, b: string | null): number {
  const ta = new Set(normName(a).split(' ').filter(Boolean))
  const tb = new Set(normName(b).split(' ').filter(Boolean))
  if (ta.size === 0 || tb.size === 0) return 0
  let hit = 0
  for (const t of ta) if (tb.has(t)) hit++
  return hit / Math.max(ta.size, tb.size)
}

/** Open balance for a job: sum of its unpaid, non-deleted invoices, else due_total. */
async function openAmount(db: SupabaseClient, job: JobRow): Promise<number | null> {
  const { data } = await db.from('sf_invoices').select('total, is_paid').eq('job_id', job.id).eq('is_deleted', false)
  const rows = (data ?? []) as Array<{ total: number | null; is_paid: boolean | null }>
  if (rows.length > 0) {
    const openInv = rows.filter(r => !r.is_paid)
    if (openInv.length === 0) return 0 // invoices exist and all are paid → nothing open
    return openInv.reduce((s, r) => s + (r.total ?? 0), 0)
  }
  return job.due_total ?? null
}

export async function matchLine(db: SupabaseClient, vendor: RemittanceVendor, line: RemittanceLine): Promise<LineMatch> {
  const empty: LineMatch = { match_status: 'no_match', sf_job_id: null, sf_job_number: null, matched_customer: null, open_amount: null, match_confidence: null, candidates: null }
  if (!line.po) return empty

  // Candidate jobs whose PO field contains this PO (narrow via ILIKE, then exact-
  // membership check to avoid partial-number false positives).
  const { data } = await db
    .from('sf_jobs')
    .select('id, number, customer_name, po_number, due_total')
    .eq('is_deleted', false)
    .ilike('po_number', `%${line.po}%`)
    .limit(50)
  const candidates = ((data ?? []) as JobRow[]).filter(j => splitPos(j.po_number).includes(line.po!))
  if (candidates.length === 0) return empty

  let chosen: JobRow | null = null
  let confidence = 1

  if (candidates.length === 1) {
    chosen = candidates[0]
    // Clopay: validate the name; a mismatch drops confidence but still matches.
    if (vendor === 'clopay' && line.customer_name) {
      confidence = Math.max(0.5, nameScore(line.customer_name, candidates[0].customer_name))
    }
  } else {
    // Multiple jobs share this PO. Disambiguate: Clopay by best name score, else
    // by an open balance that fits the paid amount; unresolved → ambiguous.
    if (vendor === 'clopay' && line.customer_name) {
      const scored = candidates.map(j => ({ j, s: nameScore(line.customer_name, j.customer_name) })).sort((a, b) => b.s - a.s)
      if (scored[0].s >= 0.5 && (scored.length < 2 || scored[0].s > scored[1].s)) { chosen = scored[0].j; confidence = scored[0].s }
    }
    if (!chosen) {
      return {
        ...empty,
        match_status: 'ambiguous',
        candidates: candidates.map(j => ({ id: j.id, number: j.number, customer_name: j.customer_name, po_number: j.po_number })),
      }
    }
  }

  const open = await openAmount(db, chosen)
  const status: MatchStatus = open != null && line.amount > open + 0.01 ? 'amount_mismatch' : 'matched'
  return {
    match_status: status,
    sf_job_id: chosen.id,
    sf_job_number: chosen.number,
    matched_customer: chosen.customer_name,
    open_amount: open,
    match_confidence: Math.round(confidence * 1000) / 1000,
    candidates: null,
  }
}
