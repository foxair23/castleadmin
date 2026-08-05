import type { SupabaseClient } from '@supabase/supabase-js'
import type { RemittanceLine, RemittanceVendor } from './parse'

// Match a remittance line to an SF job. Two stages:
//   1. PO — a job may carry several POs separated by ; or / (we check membership,
//      not equality). Clopay lines carry a customer name too, used to validate /
//      disambiguate the PO match.
//   2. Name fallback — when the PO matches nothing (vendor wrote a PO never
//      entered in SF, or a wrong/transposed PO), fall back to the customer name.
//      Guarded hard because it moves money: requires a strong, unique name match,
//      prefers the customer's job whose open balance covers the payment, and
//      returns 'ambiguous' rather than guess when two jobs remain plausible.
//
// match_method records HOW a line matched ('po' | 'po_name' | 'name') so review /
// autopilot can trust PO matches and require a human on name-only matches.

export type MatchStatus = 'matched' | 'ambiguous' | 'no_match' | 'amount_mismatch'
export type MatchMethod = 'po' | 'po_name' | 'name' | null

export interface MatchCandidate { id: string; number: string | null; customer_name: string | null; po_number: string | null }

export interface LineMatch {
  match_status: MatchStatus
  match_method: MatchMethod
  sf_job_id: string | null
  sf_job_number: string | null
  matched_customer: string | null
  open_amount: number | null
  match_confidence: number | null
  candidates: MatchCandidate[] | null
}

interface JobRow { id: string; number: string | null; customer_name: string | null; po_number: string | null; due_total: number | null }

/** A name is a confident match only at/above this token-set overlap. */
const NAME_STRONG = 0.9

const splitPos = (raw: string | null): string[] =>
  (raw ?? '').split(/[;/,]/).map(s => s.trim()).filter(Boolean)

export function normName(s: string | null | undefined): string {
  return (s ?? '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Token-set overlap 0..1 between two names — order/comma-insensitive, so
 *  "PEARSON TUYETLE" and "Pearson, Tuyetle" score 1.0. */
export function nameScore(a: string | null, b: string | null): number {
  const ta = new Set(normName(a).split(' ').filter(Boolean))
  const tb = new Set(normName(b).split(' ').filter(Boolean))
  if (ta.size === 0 || tb.size === 0) return 0
  let hit = 0
  for (const t of ta) if (tb.has(t)) hit++
  return hit / Math.max(ta.size, tb.size)
}

const round3 = (n: number) => Math.round(n * 1000) / 1000
const toCandidate = (j: JobRow): MatchCandidate => ({ id: j.id, number: j.number, customer_name: j.customer_name, po_number: j.po_number })

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

/** Pick one job from several by open balance: the lone job whose open balance
 *  covers the payment, else the one whose open equals the amount exactly. Returns
 *  null if that doesn't uniquely resolve (→ ambiguous). Used to break ties when
 *  the same customer has multiple jobs sharing a PO or a name. */
async function pickByOpen(db: SupabaseClient, jobs: JobRow[], amount: number): Promise<JobRow | null> {
  if (jobs.length === 1) return jobs[0]
  const withOpen: Array<{ j: JobRow; open: number | null }> = []
  for (const j of jobs) withOpen.push({ j, open: await openAmount(db, j) })
  const canCover = withOpen.filter(x => x.open != null && x.open + 0.01 >= amount)
  if (canCover.length === 1) return canCover[0].j
  const exact = withOpen.filter(x => x.open != null && Math.abs(x.open - amount) < 0.01)
  if (exact.length === 1) return exact[0].j
  return null
}

/** Build a matched/amount_mismatch result for a chosen job. */
async function resolve(db: SupabaseClient, job: JobRow, method: MatchMethod, confidence: number, amount: number): Promise<LineMatch> {
  const open = await openAmount(db, job)
  const status: MatchStatus = open != null && amount > open + 0.01 ? 'amount_mismatch' : 'matched'
  return {
    match_status: status,
    match_method: method,
    sf_job_id: job.id,
    sf_job_number: job.number,
    matched_customer: job.customer_name,
    open_amount: open,
    match_confidence: round3(confidence),
    candidates: null,
  }
}

/** Jobs whose customer name strongly matches, best score first. Narrows via the
 *  most distinctive name token, then scores in JS (order/comma-insensitive). */
async function findByName(db: SupabaseClient, name: string): Promise<Array<JobRow & { score: number }>> {
  const tokens = normName(name).split(' ').filter(t => t.length >= 3)
  if (tokens.length === 0) return []
  const longest = [...tokens].sort((a, b) => b.length - a.length)[0]
  const { data } = await db
    .from('sf_jobs')
    .select('id, number, customer_name, po_number, due_total')
    .eq('is_deleted', false)
    .ilike('customer_name', `%${longest}%`)
    .limit(100)
  return ((data ?? []) as JobRow[])
    .map(j => ({ ...j, score: nameScore(name, j.customer_name) }))
    .filter(j => j.score >= NAME_STRONG)
    .sort((a, b) => b.score - a.score)
}

export async function matchLine(db: SupabaseClient, vendor: RemittanceVendor, line: RemittanceLine): Promise<LineMatch> {
  const empty: LineMatch = { match_status: 'no_match', match_method: null, sf_job_id: null, sf_job_number: null, matched_customer: null, open_amount: null, match_confidence: null, candidates: null }

  // ── Stage 1: PO ──────────────────────────────────────────────────────────
  if (line.po) {
    const { data } = await db
      .from('sf_jobs')
      .select('id, number, customer_name, po_number, due_total')
      .eq('is_deleted', false)
      .ilike('po_number', `%${line.po}%`)
      .limit(50)
    const candidates = ((data ?? []) as JobRow[]).filter(j => splitPos(j.po_number).includes(line.po!))

    if (candidates.length === 1) {
      const job = candidates[0]
      // Clopay: validate the name; a mismatch drops confidence but still matches.
      if (vendor === 'clopay' && line.customer_name) {
        return resolve(db, job, 'po_name', Math.max(0.5, nameScore(line.customer_name, job.customer_name)), line.amount)
      }
      return resolve(db, job, 'po', 1, line.amount)
    }
    if (candidates.length > 1) {
      // Multiple jobs share this PO (same customer can have several jobs). Prefer
      // the best name match; if names tie — which they do when it's the same
      // customer — break the tie by which job's open balance covers the payment.
      let pool = candidates
      let method: MatchMethod = 'po'
      let confidence = 1
      if (vendor === 'clopay' && line.customer_name) {
        const scored = candidates.map(j => ({ j, s: nameScore(line.customer_name, j.customer_name) })).sort((a, b) => b.s - a.s)
        const top = scored[0].s
        if (top >= 0.5) {
          const tied = scored.filter(x => Math.abs(x.s - top) < 1e-9).map(x => x.j)
          if (tied.length === 1) return resolve(db, tied[0], 'po_name', top, line.amount)
          pool = tied; method = 'po_name'; confidence = top
        }
      }
      const winner = await pickByOpen(db, pool, line.amount)
      if (winner) return resolve(db, winner, method, confidence, line.amount)
      return { ...empty, match_status: 'ambiguous', match_method: 'po', candidates: pool.map(toCandidate) }
    }
    // candidates.length === 0 → PO isn't in SF; fall through to the name stage.
  }

  // ── Stage 2: name fallback ───────────────────────────────────────────────
  // Only when the PO didn't resolve. Handles vendor POs missing from SF or
  // written wrong, as long as the customer name is a strong, unambiguous match.
  if (line.customer_name) {
    const named = await findByName(db, line.customer_name)
    if (named.length > 0) {
      const winner = await pickByOpen(db, named, line.amount)
      if (winner) {
        const score = named.find(j => j.id === winner.id)?.score ?? NAME_STRONG
        return resolve(db, winner, 'name', score, line.amount)
      }
      // Several plausible same-name jobs — let a human/AI pick.
      return { ...empty, match_status: 'ambiguous', match_method: 'name', candidates: named.map(toCandidate) }
    }
  }

  return empty
}
