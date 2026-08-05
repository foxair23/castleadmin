import type { SupabaseClient } from '@supabase/supabase-js'
import type { RemittanceLine } from './parse'
import { nameScore, normName } from './match'

// AI residual matcher. Runs ONLY on lines deterministic matching couldn't place
// (no_match / ambiguous). We hand the model the remittance line plus a shortlist
// of name-similar SF jobs and ask it to pick one or abstain. The result is an
// advisory suggestion a human confirms at apply time — it never moves money and
// never overwrites the deterministic match.
//
// Dormant unless ANTHROPIC_API_KEY is set: no key → no call.

export function isAiMatchConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY
}

// A short structured read — Haiku is the right tier. Override with REMITTANCE_AI_MODEL.
const MODEL = process.env.REMITTANCE_AI_MODEL || 'claude-haiku-4-5'

export interface AiCandidate { id: string; number: string | null; customer_name: string | null; po_number: string | null; open_amount: number | null }
export interface AiSuggestion { job_id: string | null; job_number: string | null; customer_name: string | null; confidence: number; reason: string }

interface JobRow { id: string; number: string | null; customer_name: string | null; po_number: string | null; due_total: number | null }

async function openAmount(db: SupabaseClient, job: JobRow): Promise<number | null> {
  const { data } = await db.from('sf_invoices').select('total, is_paid').eq('job_id', job.id).eq('is_deleted', false)
  const rows = (data ?? []) as Array<{ total: number | null; is_paid: boolean | null }>
  if (rows.length > 0) {
    const openInv = rows.filter(r => !r.is_paid)
    if (openInv.length === 0) return 0
    return openInv.reduce((s, r) => s + (r.total ?? 0), 0)
  }
  return job.due_total ?? null
}

/** Name-similar SF jobs (looser than the deterministic threshold) as an AI
 *  shortlist, best first, with each job's open balance for amount sanity-check. */
export async function buildCandidates(db: SupabaseClient, line: RemittanceLine): Promise<AiCandidate[]> {
  if (!line.customer_name) return []
  const tokens = normName(line.customer_name).split(' ').filter(t => t.length >= 3)
  if (tokens.length === 0) return []
  const longest = [...tokens].sort((a, b) => b.length - a.length)[0]
  const { data } = await db
    .from('sf_jobs')
    .select('id, number, customer_name, po_number, due_total')
    .eq('is_deleted', false)
    .ilike('customer_name', `%${longest}%`)
    .limit(50)
  const scored = ((data ?? []) as JobRow[])
    .map(j => ({ j, s: nameScore(line.customer_name, j.customer_name) }))
    .filter(x => x.s >= 0.34) // include near-misses; the model makes the call
    .sort((a, b) => b.s - a.s)
    .slice(0, 12)
  const out: AiCandidate[] = []
  for (const { j } of scored) out.push({ id: j.id, number: j.number, customer_name: j.customer_name, po_number: j.po_number, open_amount: await openAmount(db, j) })
  return out
}

const SUGGEST_TOOL = {
  name: 'suggest_match',
  description: 'Record which candidate job (if any) is the same customer as the remittance line.',
  input_schema: {
    type: 'object',
    properties: {
      job_id: { type: 'string', description: 'The id of the matching candidate job, copied EXACTLY from the list. Empty string if none is a confident match.' },
      confidence: { type: 'number', description: 'Confidence 0 to 1 in the chosen match (0 if abstaining).' },
      reason: { type: 'string', description: 'One short sentence explaining the choice or the abstention.' },
    },
    required: ['job_id', 'confidence', 'reason'],
  },
} as const

/** Ask the model to pick a candidate or abstain. Returns null on any failure; a
 *  suggestion with job_id=null means an explicit abstention (reason retained). */
export async function aiSuggestMatch(line: RemittanceLine, candidates: AiCandidate[]): Promise<AiSuggestion | null> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key || candidates.length === 0) return null
  const list = candidates
    .map((c, i) => `${i + 1}. id=${c.id} | name="${c.customer_name ?? ''}" | PO=${c.po_number ?? ''} | open_balance=${c.open_amount ?? '?'}`)
    .join('\n')
  const prompt =
    `A vendor payment-remittance line must be matched to the correct Service Fusion job/customer. ` +
    `The vendor's PO may be missing or wrong, so match PRIMARILY by CUSTOMER NAME — names may be reversed ` +
    `or comma-separated (e.g. "PEARSON TUYETLE" is the same as "Pearson, Tuyetle") — and sanity-check the ` +
    `amount against the job's open balance. Pick the candidate that is the same customer, or abstain ` +
    `(empty job_id) if none is a confident match. Only use an id from the list; never invent one.\n\n` +
    `REMITTANCE LINE:\ncustomer="${line.customer_name ?? ''}"  PO=${line.po ?? ''}  amount=${line.amount}\n\n` +
    `CANDIDATES:\n${list}`
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 512,
        tools: [SUGGEST_TOOL],
        tool_choice: { type: 'tool', name: 'suggest_match' },
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { content?: Array<{ type: string; input?: Record<string, unknown> }> }
    const out = (data.content ?? []).find(b => b.type === 'tool_use')?.input
    if (!out) return null
    const jobId = typeof out.job_id === 'string' && out.job_id.trim() ? out.job_id.trim() : null
    const reason = String(out.reason ?? '')
    if (!jobId) return { job_id: null, job_number: null, customer_name: null, confidence: 0, reason: reason || 'no confident match' }
    const chosen = candidates.find(c => c.id === jobId)
    if (!chosen) return null // model returned an id not in the list — discard
    return {
      job_id: chosen.id,
      job_number: chosen.number,
      customer_name: chosen.customer_name,
      confidence: Math.max(0, Math.min(1, Number(out.confidence) || 0)),
      reason,
    }
  } catch {
    return null
  }
}
