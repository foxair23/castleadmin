import type { AgentSettings, QuestionType } from '@/lib/agent/settings'
import { autoSendDecision, type ConfidenceInput } from './confidence'

// Stage 5 — route a composed draft (PRD §5, §6.3): auto-send (queued, with the hold
// window) or human review (draft). Pure, so it is testable and so the Settings page can
// run the same function over recent drafts to show "at this threshold, X% of the last
// 30 days would have auto-sent".

export interface RouteDecision {
  status: 'queued' | 'draft'
  approval_path: 'auto' | null
  send_after: string | null
  /** Every reason it did NOT auto-send. Empty when it queued. */
  blockers: string[]
}

export function decideRoute(input: ConfidenceInput, score: number, settings: AgentSettings, now: Date = new Date()): RouteDecision {
  const d = autoSendDecision(input, score, settings)
  if (!d.ok) return { status: 'draft', approval_path: null, send_after: null, blockers: d.reasons }
  const sendAfter = new Date(now.getTime() + Math.max(0, settings.hold_minutes) * 60_000).toISOString()
  return { status: 'queued', approval_path: 'auto', send_after: sendAfter, blockers: [] }
}

/** A stored reply, reduced to what the decision needs. */
export interface RoutableReply {
  confidence: number | null
  question_type: string | null
  resolve_status: string | null
  resolve_tier: string | null
  hard_fail_reasons: string[]
  unsourced_claims: string[]
  live_fetched_at: string | null
}

export function toConfidenceInput(r: RoutableReply): ConfidenceInput {
  return {
    resolveStatus: (r.resolve_status as ConfidenceInput['resolveStatus']) ?? 'none',
    resolveTier: (r.resolve_tier as ConfidenceInput['resolveTier']) ?? null,
    questionType: (r.question_type as QuestionType) ?? 'other',
    fullyGrounded: !r.hard_fail_reasons.includes('ungrounded'),
    unsourcedCount: r.unsourced_claims.length,
    liveFresh: !!r.live_fetched_at && !r.hard_fail_reasons.includes('refresh_failed'),
    hardFailReasons: r.hard_fail_reasons,
  }
}

export interface AutoShareEstimate {
  total: number
  wouldAutoSend: number
  share: number                 // 0–1
  /** Blocker → how many drafts it stopped (a draft can appear under several). */
  blockedBy: Record<string, number>
}

/** What share of these (recent) drafts would auto-send under `settings`, ignoring the
 *  master switch — the estimate is about the threshold and toggles, not whether auto is on. */
export function estimateAutoShare(replies: RoutableReply[], settings: AgentSettings): AutoShareEstimate {
  const s: AgentSettings = { ...settings, auto_respond_enabled: true }
  const blockedBy: Record<string, number> = {}
  let would = 0
  for (const r of replies) {
    const d = autoSendDecision(toConfidenceInput(r), r.confidence ?? 0, s)
    if (d.ok) would++
    else for (const b of d.reasons) blockedBy[b] = (blockedBy[b] ?? 0) + 1
  }
  return { total: replies.length, wouldAutoSend: would, share: replies.length ? would / replies.length : 0, blockedBy }
}
