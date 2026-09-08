import type { SupabaseClient } from '@supabase/supabase-js'
import type { StyleExample } from '@/lib/agent/knowledge'
import type { QuestionType } from '@/lib/agent/settings'

// The learning loop (PRD §9). Three things that compound:
//   • Coverage demand log → a ranked build list ("37 ship-date requests, 12 warranty…"),
//     each cluster one tap from becoming an answer-library entry.
//   • Style retrieval → the composer sees the most SIMILAR human-verified examples, not
//     the first N, so the corpus can grow without bloating every prompt.
//   • Edit rate → the Phase-2 gate (PRD §14: unedited ≥ 95% on a tier) as a number.

// ── Coverage demand log ─────────────────────────────────────────────────────

export interface CoverageRow { id: string; message_id: string | null; question_type: string; missing: string; created_at: string }
export interface CoverageCluster {
  key: string
  questionType: string
  /** Representative wording (the most recent). */
  missing: string
  count: number
  firstSeen: string
  lastSeen: string
  messageIds: string[]
}

const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'is', 'are', 'was', 'this', 'that', 'and', 'or', 'with', 'from', 'at', 'by', 'not', 'no', 'any', 'we', 'i', 'it', 'be', 'has', 'have', 'do', 'does', 'did', 'about', 'their', 'our', 'your', 'po', 'job', 'order'])
export const fingerprint = (s: string): string =>
  s.toLowerCase().replace(/\d{6,}/g, ' ').replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)).slice(0, 6).sort().join(' ')

/** Group log rows into clusters by question type + wording fingerprint, biggest first. */
export function groupCoverageLog(rows: CoverageRow[]): CoverageCluster[] {
  const m = new Map<string, CoverageCluster>()
  for (const r of [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const fp = fingerprint(r.missing) || r.missing.toLowerCase().slice(0, 40)
    const key = `${r.question_type}|${fp}`
    const c = m.get(key)
    if (c) { c.count++; c.lastSeen = r.created_at; c.missing = r.missing; if (r.message_id) c.messageIds.push(r.message_id) }
    else m.set(key, { key, questionType: r.question_type, missing: r.missing, count: 1, firstSeen: r.created_at, lastSeen: r.created_at, messageIds: r.message_id ? [r.message_id] : [] })
  }
  return [...m.values()].sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen))
}

export async function loadCoverageLog(db: SupabaseClient, days = 90): Promise<CoverageRow[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const { data } = await db.from('agent_coverage_log').select('id, message_id, question_type, missing, created_at').gte('created_at', since).order('created_at', { ascending: false }).limit(2000)
  return (data ?? []) as CoverageRow[]
}

// ── Style retrieval ─────────────────────────────────────────────────────────

const tokens = (s: string | null | undefined): Set<string> => new Set((s ?? '').toLowerCase().replace(/\d{6,}/g, ' ').split(/[^a-z]+/).filter(w => w.length > 3 && !STOP.has(w)))

/** Pinned examples always; then the most similar human-verified ones for this inquiry. */
export function pickStyleExamples(all: StyleExample[], questionType: QuestionType | string, inquiryText: string, limit = 8): StyleExample[] {
  const live = all.filter(e => !e.is_deleted)
  const pinned = live.filter(e => e.is_pinned)
  const q = tokens(inquiryText)
  const score = (e: StyleExample): number => {
    const t = tokens(`${e.inquiry_text ?? ''} ${e.final_text}`)
    let overlap = 0; for (const w of q) if (t.has(w)) overlap++
    const jaccard = q.size + t.size ? overlap / (q.size + t.size - overlap) : 0
    const typeBonus = e.question_type && e.question_type === questionType ? 0.3 : 0
    const sourceBonus = e.source === 'human_edit' ? 0.15 : e.source === 'human_approved' ? 0.1 : e.source === 'staff' ? 0.1 : 0
    const ageDays = (Date.now() - Date.parse(e.created_at)) / 86_400_000
    const recency = Number.isFinite(ageDays) ? Math.max(0, 0.1 - ageDays / 3650) : 0
    return jaccard + typeBonus + sourceBonus + recency
  }
  const rest = live.filter(e => !e.is_pinned).map(e => [score(e), e] as const).sort((a, b) => b[0] - a[0]).map(([, e]) => e)
  return [...pinned, ...rest].slice(0, Math.max(limit, pinned.length))
}

// ── Edit rate ───────────────────────────────────────────────────────────────

export interface EditRateRow { question_type: string | null; resolve_tier: string | null; status: string; approval_path: string | null; was_edited: boolean }
export interface EditRate { key: string; questionType: string; tier: string; reviewed: number; unedited: number; edited: number; rejected: number; escalated: number; auto: number; uneditedRate: number }

/** Human decisions per question type + tier. uneditedRate = approved unedited / (approved + edited). */
export function editRateByType(rows: EditRateRow[]): EditRate[] {
  const m = new Map<string, EditRate>()
  for (const r of rows) {
    const qt = r.question_type ?? 'other', tier = r.resolve_tier ?? 'none', key = `${qt}:${tier}`
    const e = m.get(key) ?? { key, questionType: qt, tier, reviewed: 0, unedited: 0, edited: 0, rejected: 0, escalated: 0, auto: 0, uneditedRate: 0 }
    if (r.approval_path === 'auto') e.auto++
    else if (r.status === 'rejected') { e.reviewed++; e.rejected++ }
    else if (r.status === 'escalated') { e.reviewed++; e.escalated++ }
    else if (r.approval_path === 'approved' || r.approval_path === 'edited' || r.approval_path === 'chat_approved') { e.reviewed++; if (r.was_edited) e.edited++; else e.unedited++ }
    const decided = e.unedited + e.edited
    e.uneditedRate = decided ? e.unedited / decided : 0
    m.set(key, e)
  }
  return [...m.values()].sort((a, b) => b.reviewed - a.reviewed)
}

export async function loadEditRateRows(db: SupabaseClient, days = 30): Promise<EditRateRow[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const { data } = await db.from('agent_email_replies').select('question_type, resolve_tier, status, approval_path, was_edited').gte('created_at', since).limit(2000)
  return (data ?? []) as EditRateRow[]
}
