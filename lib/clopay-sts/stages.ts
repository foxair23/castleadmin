// Clopay STS status pipeline (order matters — used for "advance to at least X").
// 'Received' is set on ingest; 'Requested from DC' the moment the DC email sends;
// 'Detail Received' when the DC's reply lands; the rest are set by the office via the
// dropdown; 'Closed' is the terminal that clears the order from the Action Items STS tab.
export const CLOPAY_STS_STAGES = [
  'Received',
  'Requested from DC',
  'Detail Received',
  'Staged',
  'Delivered',
  'Closed (invoiced/billed)',
] as const

export type StsStage = (typeof CLOPAY_STS_STAGES)[number]

export const STS_CLOSED = 'Closed (invoiced/billed)'
export const STS_REQUESTED = 'Requested from DC'
export const STS_DETAIL_RECEIVED = 'Detail Received'

/** Advance to at least `target`, never backwards through the pipeline. An order the office
 *  has already moved on to Staged or Delivered must not be dragged back by a late DC reply. */
export function advancedStatus(current: string | null, target: string): string {
  const ci = CLOPAY_STS_STAGES.indexOf((current ?? '') as StsStage)
  const ti = CLOPAY_STS_STAGES.indexOf(target as StsStage)
  return ci > ti ? (current as string) : target
}
