// Pure helpers for classifying a Service Fusion job status by completion state.
// Kept dependency-free so they can be unit-tested without the sync engine.

/** "Work done or later" — Completed / Invoiced / Paid. */
export const COMPLETEDISH = /complet|invoic|paid/i
/** Cancelled/void statuses (never recognized). */
export const CANCELLEDISH = /^\s*(cancelled|canceled|void|voided)\s*$/i

export function isCompletedish(status: string | null | undefined): boolean {
  return COMPLETEDISH.test((status ?? '').trim())
}

/**
 * A status that should NOT be treated as work-complete: a real, open status
 * that is neither completed-ish nor cancelled. Used to detect a job whose
 * completion was rolled back (e.g. Completed → "Waiting on Parts").
 */
export function isRevertedCandidateStatus(status: string | null | undefined): boolean {
  const s = (status ?? '').trim()
  return s !== '' && !COMPLETEDISH.test(s) && !CANCELLEDISH.test(s)
}
