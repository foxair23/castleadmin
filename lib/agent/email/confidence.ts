import type { AgentSettings, QuestionType, MatchTier } from '@/lib/agent/settings'
import type { ResolveTier } from '@/lib/agent/job-resolver'

// Confidence — computed from deterministic signals, never from the model's opinion of
// itself (PRD §6.3). Used to SORT the review queue (highest first, so reviewers see the
// best drafts before fatigue sets in) and, once auto-send is on, to gate sending
// against the configured threshold.
//
// Hard failures (ungrounded claim, ambiguous/no match, failed live read, several
// questions, sender wants a human, model could not answer) are NOT score reductions:
// they block auto-send regardless of score. They still lower the score so the queue
// orders sensibly.

export interface ConfidenceInput {
  resolveStatus: 'matched' | 'ambiguous' | 'none'
  resolveTier: ResolveTier | null
  questionType: QuestionType
  fullyGrounded: boolean
  unsourcedCount: number
  liveFresh: boolean
  hardFailReasons: string[]
}

export interface ConfidenceBreakdown {
  match: number      // 0–1
  coverage: number   // 0–1
  grounding: number  // 0–1
  freshness: number  // 0–1
  penalties: string[]
}

const WEIGHTS = { match: 0.4, coverage: 0.15, grounding: 0.3, freshness: 0.15 }

export function computeConfidence(i: ConfidenceInput, settings: AgentSettings): { score: number; breakdown: ConfidenceBreakdown } {
  const match = i.resolveStatus !== 'matched' ? 0 : i.resolveTier === 'po' ? 1 : i.resolveTier === 'name' ? 0.75 : 0.6
  const coverage = settings.auto_question_types.includes(i.questionType) ? 1 : 0.4
  const grounding = i.fullyGrounded ? 1 : Math.max(0, 0.5 - 0.15 * i.unsourcedCount)
  const freshness = i.liveFresh ? 1 : 0
  let score = WEIGHTS.match * match + WEIGHTS.coverage * coverage + WEIGHTS.grounding * grounding + WEIGHTS.freshness * freshness
  const penalties: string[] = []
  for (const r of i.hardFailReasons) if (['multi_part', 'asks_for_human', 'could_not_answer'].includes(r)) { score -= 0.15; penalties.push(r) }
  score = Math.max(0, Math.min(1, Math.round(score * 1000) / 1000))
  return { score, breakdown: { match, coverage, grounding, freshness, penalties } }
}

/** Would this draft auto-send under the current settings? Lists every blocker in plain codes. */
export function autoSendDecision(i: ConfidenceInput, score: number, settings: AgentSettings): { ok: boolean; reasons: string[] } {
  const reasons = [...i.hardFailReasons]
  if (!settings.auto_respond_enabled) reasons.push('auto_off')
  if (!settings.auto_question_types.includes(i.questionType)) reasons.push('type_not_auto')
  const tier = (i.resolveTier === 'po' || i.resolveTier === 'name') ? (i.resolveTier as MatchTier) : null
  if (!tier || !settings.auto_match_tiers.includes(tier)) reasons.push('tier_not_auto')
  if (tier && settings.paused_tiers[`${i.questionType}:${tier}`]) reasons.push('tier_paused')
  if (score < settings.confidence_threshold) reasons.push('below_threshold')
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] }
}
