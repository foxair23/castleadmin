// Clopay STS status pipeline (order matters — used for "advance to at least X").
// 'Received' is set on ingest; 'Requested from DC' the moment the DC email sends;
// the rest are set by the office via the dropdown; 'Closed' is the terminal that
// clears the order from the Action Items STS tab.
export const CLOPAY_STS_STAGES = [
  'Received',
  'Requested from DC',
  'Staged',
  'Delivered',
  'Closed (invoiced/billed)',
] as const

export type StsStage = (typeof CLOPAY_STS_STAGES)[number]

export const STS_CLOSED = 'Closed (invoiced/billed)'
export const STS_REQUESTED = 'Requested from DC'
