import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentSettings, QuestionType } from '@/lib/agent/settings'
import type { LiveJobFacts } from '@/lib/agent/live-refresh'
import { getActiveCharter, listInstructions, listStyleExamples } from '@/lib/agent/knowledge'
import { classifyInquiry } from './classify'
import { buildGrounding } from './grounding'
import { composeReply, renderBody } from './compose'
import { checkGrounding } from './grounding-check'
import { concreteValues } from './grounding-check'
import { extractIdentifiers } from './identifiers'
import { pickStyleExamples } from './learning'
import { stripDisclosure } from './review'
import { describeLlmError } from '@/lib/agent/llm'

// Regression set + drift detection (PRD §10, §14). 30–50 real inquiries with
// known-correct replies, runnable on demand. Each case freezes the LIVE FACTS the good
// reply was written from, so a run never touches Service Fusion and compares like with
// like across model / prompt / charter changes. Run before and after any such change.
//
// Pass = grounded (no unsourced claims) AND every concrete value in the expected reply
// appears in the produced reply AND the wording is reasonably similar. The score is
// a number for trend lines; the per-case diff is what a person reads.

export interface RegressionCase {
  id: string; name: string; inbound_text: string; inbound_from: string | null; identifiers: Record<string, unknown>
  facts_fixture: LiveJobFacts | null; expected_text: string; is_active: boolean; last_run_at: string | null; last_result: CaseResult | null
  source_reply_id: string | null; question_type: string | null; sf_job_number: string | null; created_at: string
}
export interface CaseResult {
  score: number; passed: boolean; grounded: boolean; similarity: number
  unsourced: string[]; missing_values: string[]; produced_text: string; question_type: string | null; error?: string
}
export interface RegressionRun {
  id: string; ran_at: string; model: string | null; classifier_model: string | null; prompt_version: number | null; charter_version: number | null
  cases: number; passed: number; mean_score: number | null; results: Array<CaseResult & { case_id: string; name: string }>; note: string | null
}

/** Freeze a human-verified reply as a case. Only sent/approved replies qualify. */
export async function createCaseFromReply(db: SupabaseClient, replyId: string, userId: string | null): Promise<RegressionCase> {
  const { data: r } = await db.from('agent_email_replies').select('id, message_id, status, sent_text, composed_text, approval_path, identifiers, live_facts, question_type, sf_job_number').eq('id', replyId).single()
  if (!r) throw new Error('Reply not found')
  if (!['sent', 'queued'].includes(r.status as string) || !(r.sent_text || r.composed_text)) throw new Error('Only an approved or sent reply can become a test case.')
  if (r.approval_path === 'auto') throw new Error('Auto-sent replies were never verified by a person; approve one by hand first.')
  const { data: m } = await db.from('agent_email_messages').select('from_addr, from_name, subject, body_text').eq('id', r.message_id as string).single()
  const expected = stripDisclosure((r.sent_text ?? r.composed_text) as string)
  const name = `${(m?.subject as string | null) ?? 'inquiry'} · ${(m?.from_addr as string | null)?.split('@')[1] ?? ''}`.slice(0, 120)
  const { data, error } = await db.from('agent_regression_cases').insert({
    name, inbound_text: `Subject: ${m?.subject ?? ''}\n\n${m?.body_text ?? ''}`, inbound_from: m?.from_addr ?? null,
    identifiers: r.identifiers ?? {}, facts_fixture: r.live_facts, expected_text: expected, is_active: true,
    source_reply_id: replyId, question_type: r.question_type, sf_job_number: r.sf_job_number, created_by: userId,
  }).select('*').single()
  if (error) throw new Error(error.message)
  return data as RegressionCase
}

// ── Scoring (pure) ──────────────────────────────────────────────────────────

const toks = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2))
export function similarity(a: string, b: string): number {
  const A = toks(a), B = toks(b); if (!A.size && !B.size) return 1
  let inter = 0; for (const w of A) if (B.has(w)) inter++
  return inter / (A.size + B.size - inter)
}
const norm = (s: string) => s.toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/[.,]/g, '').replace(/\s+/g, ' ').trim()

/** Which concrete values (dates, times, names, numbers) in the expected reply are absent from the produced one. */
export function missingValues(expected: string, produced: string): string[] {
  const hay = norm(produced)
  return concreteValues(expected).filter(v => {
    const n = norm(v)
    if (hay.includes(n)) return false
    const parts = n.split(' ')
    return !(parts.length > 1 && parts.every(p => hay.includes(p)))
  })
}

export function scoreCase(expected: string, produced: string, grounded: boolean, unsourced: string[]): Omit<CaseResult, 'produced_text' | 'question_type'> {
  const sim = similarity(expected, produced)
  const missing = missingValues(expected, produced)
  const valueCoverage = concreteValues(expected).length ? 1 - missing.length / concreteValues(expected).length : 1
  const score = Math.round((0.5 * (grounded ? 1 : 0) + 0.3 * valueCoverage + 0.2 * Math.min(1, sim / 0.5)) * 1000) / 1000
  const passed = grounded && missing.length === 0 && sim >= 0.25
  return { score, passed, grounded, similarity: Math.round(sim * 1000) / 1000, unsourced, missing_values: missing }
}

// ── Dry compose (no DB writes, no Service Fusion) ───────────────────────────

export async function dryCompose(db: SupabaseClient, settings: AgentSettings, c: RegressionCase): Promise<CaseResult> {
  const fromAddr = c.inbound_from ?? 'partner@example.com'
  const domain = fromAddr.split('@')[1] ?? ''
  const subjectMatch = /^Subject:\s*(.*)$/m.exec(c.inbound_text)
  const subject = subjectMatch?.[1]?.trim() ?? c.name
  const body = c.inbound_text.replace(/^Subject:.*\n+/, '').trim()
  try {
    const cls = await classifyInquiry({ subject, body, fromDomain: domain, model: settings.classifier_model })
    const questionType: QuestionType = cls?.questionType ?? 'other'
    const ids = extractIdentifiers(body, { excludeEmails: [fromAddr] })
    const identifiers = { pos: [...new Set([...ids.pos, ...(cls?.extraPos ?? []), ...(((c.identifiers as { pos?: string[] }).pos) ?? [])])], customerName: cls?.customerName ?? null, email: ids.email, phone: ids.phone }
    const f = c.facts_fixture
    const matchOverride = f ? { job: { id: f.jobId, number: f.jobNumber, customer_id: null, customer_name: f.customerName, po_number: f.poNumber, status: f.status, start_date: f.startDate, closed_at: f.completedAt }, tier: 'po' as const, matchedPo: identifiers.pos[0] } : null
    const pack = await buildGrounding(db, { identifiers, questionType, questionText: `${subject}\n${body}`, settings, liveOverride: f, matchOverride })
    const [charter, instructions, styles] = await Promise.all([getActiveCharter(db), listInstructions(db), listStyleExamples(db)])
    const composed = await composeReply({
      settings, charter, instructions, styleExamples: pickStyleExamples(styles, questionType, `${subject}\n${body}`, 8), facts: pack.facts, gaps: pack.gaps, questionType,
      questionSummary: cls?.summary ?? subject, partner: { fromName: null, fromAddr, company: /homedepot/.test(domain) ? 'Home Depot' : /clopay/.test(domain) ? 'Clopay' : domain }, subject, body, thread: [],
    })
    if (!composed) throw new Error('composer returned nothing')
    const report = checkGrounding(composed.claims, pack.facts)
    const produced = renderBody(composed.claims)
    return { ...scoreCase(c.expected_text, produced, report.fullyGrounded, report.unsourced), produced_text: produced, question_type: questionType }
  } catch (e) {
    const err = describeLlmError(e)
    return { score: 0, passed: false, grounded: false, similarity: 0, unsourced: [], missing_values: [], produced_text: '', question_type: null, error: err }
  }
}

/** Run every active case (or a subset), store per-case results and one run record. */
export async function runRegression(db: SupabaseClient, settings: AgentSettings, opts: { userId?: string | null; note?: string | null; max?: number } = {}): Promise<RegressionRun> {
  const { data: cases } = await db.from('agent_regression_cases').select('*').eq('is_active', true).order('created_at', { ascending: true }).limit(opts.max ?? 60)
  const list = (cases ?? []) as RegressionCase[]
  const charter = await getActiveCharter(db)
  const results: RegressionRun['results'] = []
  for (const c of list) {
    const r = await dryCompose(db, settings, c)
    results.push({ ...r, case_id: c.id, name: c.name })
    await db.from('agent_regression_cases').update({ last_run_at: new Date().toISOString(), last_result: r }).eq('id', c.id)
  }
  const passed = results.filter(r => r.passed).length
  const mean = results.length ? Math.round((results.reduce((s, r) => s + r.score, 0) / results.length) * 1000) / 1000 : null
  const { data: run, error } = await db.from('agent_regression_runs').insert({
    ran_by: opts.userId ?? null, model: settings.composer_model, classifier_model: settings.classifier_model, prompt_version: settings.prompt_version, charter_version: charter.version,
    cases: results.length, passed, mean_score: mean, results, note: opts.note ?? null,
  }).select('*').single()
  if (error) throw new Error(error.message)
  return run as RegressionRun
}

// ── Trend / drift (pure) ────────────────────────────────────────────────────

export interface WeekPoint { week: string; editRate: number | null; confusionRate: number | null; drafts: number }

/** Sustained movement, not just a threshold: the last 2 weeks vs the prior 4-week mean (PRD §10 drift). */
export function detectDrift(points: WeekPoint[], metric: 'editRate' | 'confusionRate', minDelta = 0.1): { drifting: boolean; recent: number | null; baseline: number | null } {
  const vals = points.map(p => p[metric]).filter((v): v is number => v != null)
  if (vals.length < 6) return { drifting: false, recent: null, baseline: null }
  const recent = (vals[vals.length - 1] + vals[vals.length - 2]) / 2
  const base = vals.slice(-6, -2)
  const baseline = base.reduce((a, b) => a + b, 0) / base.length
  return { drifting: recent - baseline >= minDelta, recent, baseline }
}
