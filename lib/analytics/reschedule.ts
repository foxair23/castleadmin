export type ChangeType = 'initial' | 'rescheduled' | 'cancelled'
export type RescheduleReason = 'customer_requested' | 'parts_or_incomplete' | 'unknown'
export type RescheduleReasonSource = 'status' | 'heuristic'

// SF statuses that indicate the tech was on-site and couldn't complete
const PARTIAL_COMPLETE_KEYWORDS = [
  'partial', 'incomplete', 'parts', 'pending parts', 'return visit',
]

export function isPartialCompleteStatus(statusName: string): boolean {
  const lower = statusName.toLowerCase()
  return PARTIAL_COMPLETE_KEYWORDS.some(kw => lower.includes(kw))
}

export interface RescheduleClassification {
  reason: RescheduleReason
  source: RescheduleReasonSource
}

/**
 * Classify WHY a job was rescheduled.
 *
 * Priority order:
 * 1. Job had a "Partially Complete" (or similar) status → parts_or_incomplete (status signal, high confidence)
 * 2. Rescheduled on/after original scheduled date AND new date within 4 days → parts_or_incomplete (heuristic)
 * 3. Rescheduled before original scheduled date → customer_requested (heuristic)
 * 4. Otherwise → unknown
 */
export function classifyReschedule(opts: {
  previousScheduledAt: Date
  newScheduledAt: Date
  observedAt: Date          // when our sync detected the change
  jobStatusAtChange: string // raw status name when detected
}): RescheduleClassification {
  const { previousScheduledAt, newScheduledAt, observedAt, jobStatusAtChange } = opts

  // Signal 1: status-based (definitive)
  if (isPartialCompleteStatus(jobStatusAtChange)) {
    return { reason: 'parts_or_incomplete', source: 'status' }
  }

  // Signal 2: timing heuristics
  const diffDays = (newScheduledAt.getTime() - previousScheduledAt.getTime()) / 86_400_000
  const detectedAfterScheduled = observedAt >= previousScheduledAt
  const newDateIsNear = diffDays >= 0 && diffDays <= 4

  if (detectedAfterScheduled && newDateIsNear) {
    return { reason: 'parts_or_incomplete', source: 'heuristic' }
  }

  if (!detectedAfterScheduled) {
    return { reason: 'customer_requested', source: 'heuristic' }
  }

  return { reason: 'unknown', source: 'heuristic' }
}
